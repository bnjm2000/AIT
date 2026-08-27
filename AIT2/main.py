#!/usr/bin/env python3
"""Server entry point for Showbase."""

import os

from app import app, init_data_manager, run_https_app


application = app


def main():
    # Keep main.py as the stable Task Scheduler entry point. The supervisor
    # owns both the local Waitress process and the public Caddy TLS proxy.
    if os.name == 'nt':
        from server_supervisor import main as run_server_stack

        return run_server_stack()

    init_data_manager()
    run_https_app(app)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
