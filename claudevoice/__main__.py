import argparse
import sys

from . import config as settings
from . import service


def main() -> int:
    parser = argparse.ArgumentParser(prog="claudevoice", description="Reads Claude's replies aloud with Kokoro.")
    parser.add_argument("command", choices=["start", "stop", "serve"], help="start: run in the background if not already running; stop: shut it down; serve: run here")
    args = parser.parse_args()
    try:
        config = settings.load()
    except (ValueError, TypeError) as error:
        print(f"config.json: {error}")
        return 1
    if args.command == "start":
        return service.start(config)
    if args.command == "stop":
        return service.stop(config)
    return service.serve(config)


if __name__ == "__main__":
    sys.exit(main())
