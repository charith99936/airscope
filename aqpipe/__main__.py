import warnings

warnings.filterwarnings("ignore", message=".*OpenSSL.*")

from .cli import main  # noqa: E402

main()
