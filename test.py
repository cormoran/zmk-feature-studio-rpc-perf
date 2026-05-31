import platform
import shutil
import subprocess
import unittest
from pathlib import Path

from dataclasses import dataclass

THIS_DIR = Path(__file__).parent.resolve()


def run_west(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        ["west", *args],
        capture_output=True,
        text=True,
        cwd=THIS_DIR,
    )


@dataclass
class NotFound:
    text: str


@dataclass
class ConfigAndDeviceTree:
    # Expected rows in .config
    config: list[str | NotFound]
    # Expected rows in devicetree_generated.h
    device: list[str | NotFound]


class WestCommandsTests(unittest.TestCase):
    WEST_TOPDIR: Path
    BUILD_DIR: Path

    @classmethod
    def setUpClass(cls):
        cls.WEST_TOPDIR = Path(run_west(["topdir"]).stdout.strip())
        cls.BUILD_DIR = cls.WEST_TOPDIR / "build"

    @unittest.skipUnless(
        platform.system() == "Linux", "zmk-test is only supported on Linux"
    )
    def test_zmk_test(self):
        test_build_dir = self.BUILD_DIR / THIS_DIR.name
        shutil.rmtree(test_build_dir, ignore_errors=True)

        result = run_west(["zmk-test", "tests", "-m", ".", "-d", str(test_build_dir)])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("PASS: studio", result.stdout, result.stdout + result.stderr)
        self.assertNotIn("FAILED: ", result.stdout, result.stdout + result.stderr)

    def test_zmk_build(self):
        self._test_zmk_build(
            {
                "my_awesome_keyboard_with_custom_rpc_support": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_MY_AWESOME_KEYBOARD_SPECIAL_FEATURE=y",
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_STUDIO_RPC_PERF=y",
                        "CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER=y",
                    ],
                    device=[],
                ),
                "my_awesome_keyboard_split_central_with_custom_rpc_support": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_MY_AWESOME_KEYBOARD_SPECIAL_FEATURE=y",
                        "CONFIG_ZMK_STUDIO=y",
                        "CONFIG_ZMK_STUDIO_RPC_PERF=y",
                        "CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER=y",
                        "CONFIG_ZMK_SPLIT=y",
                        "CONFIG_ZMK_SPLIT_ROLE_CENTRAL=y",
                        "CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY=y",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT=y",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=80",
                        "CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE=64",
                    ],
                    device=[],
                ),
                "my_awesome_keyboard_split_peripheral_with_perf_support": ConfigAndDeviceTree(
                    config=[
                        "CONFIG_MY_AWESOME_KEYBOARD_SPECIAL_FEATURE=y",
                        "CONFIG_ZMK_STUDIO_RPC_PERF=y",
                        "CONFIG_ZMK_SPLIT=y",
                        NotFound("CONFIG_ZMK_SPLIT_ROLE_CENTRAL=y"),
                        "CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY=y",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT=y",
                        "CONFIG_ZMK_SPLIT_RELAY_EVENT_DATA_LEN=80",
                        "CONFIG_ZMK_STUDIO_RPC_PERF_SPLIT_RPC_RELAY_CHUNK_SIZE=64",
                        NotFound("CONFIG_ZMK_STUDIO_RPC_PERF_HANDLER=y"),
                    ],
                    device=[],
                ),
            }
        )

    def _test_zmk_build(
        self, artifacts_and_expected_build_params: dict[str, ConfigAndDeviceTree]
    ):

        for artifact in artifacts_and_expected_build_params.keys():
            shutil.rmtree(self.BUILD_DIR / artifact, ignore_errors=True)

        result = run_west(["zmk-build", "tests/zmk-config", "-q"])
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

        for artifact, entries in artifacts_and_expected_build_params.items():
            artifact_dir = self.BUILD_DIR / artifact / "zephyr"
            config_path = artifact_dir / ".config"
            device_tree_path = (
                artifact_dir
                / "include"
                / "generated"
                / "zephyr"
                / "devicetree_generated.h"
            )
            self._test_strings_in_file(
                config_path, entries.config, f"{artifact} config"
            )
            if entries.device:
                self._test_strings_in_file(
                    device_tree_path, entries.device, f"{artifact} device tree"
                )
            self.assertTrue(
                (artifact_dir / "zmk.uf2").exists(),
                f"{artifact} zmk.uf2 is missing in {artifact_dir}",
            )

    def _test_strings_in_file(
        self, file_path: Path, expected_strings: list[str | NotFound], hint: str
    ):
        self.assertTrue(file_path.exists(), f"{hint}: {file_path} is missing")
        file_text = file_path.read_text()

        for expected in expected_strings:
            if isinstance(expected, NotFound):
                if expected.text in file_text:
                    self.fail(
                        f"{hint}: {expected.text} found in {file_path}, but it should not be present"
                    )
            else:
                if expected not in file_text:
                    self.fail(f"{hint}: {expected} not found in {file_path}")


if __name__ == "__main__":
    unittest.main()
