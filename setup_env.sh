#!/bin/zsh
# Creates .venv and installs dependencies. On macOS without Homebrew's libomp,
# LightGBM is pointed at the OpenMP runtime that scikit-learn's wheel bundles.
set -e
cd "$(dirname "$0")"
[ -d .venv ] || python3 -m venv .venv
.venv/bin/python -m pip install -q --upgrade pip
.venv/bin/python -m pip install -q --retries 10 --timeout 60 -r requirements.txt

if [ "$(uname)" = "Darwin" ] && ! .venv/bin/python -c "import lightgbm" 2>/dev/null; then
  SITE=$(.venv/bin/python -c "import sysconfig; print(sysconfig.get_paths()['purelib'])")
  LIB="$SITE/lightgbm/lib/lib_lightgbm.dylib"
  install_name_tool -add_rpath "@loader_path/../../sklearn/.dylibs" "$LIB"
  codesign --force -s - "$LIB"
  .venv/bin/python -c "import lightgbm; print('lightgbm', lightgbm.__version__, 'OK (using scikit-learn libomp)')"
fi
