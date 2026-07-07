#!/usr/bin/env python3
"""Web-only server entry point for Showbase."""

from app import app, init_data_manager, run_https_app


application = app


def main():
    init_data_manager()
    run_https_app(app)


if __name__ == "__main__":
    main()
