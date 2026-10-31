import argparse

import uvicorn


def main() -> None:
    parser = argparse.ArgumentParser(description="웹 리듬게임 실행")
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    uvicorn.run("rhythm_game.server:app", host=args.host, port=args.port)


if __name__ == "__main__":
    main()
