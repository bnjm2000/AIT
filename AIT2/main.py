#!/usr/bin/env python3
"""Web-only server entry point for AVEC Inventory Tracker."""

import os

from app import app, init_data_manager


application = app


def main():
    init_data_manager()
    app.run(
        debug=os.environ.get("FLASK_DEBUG") == "1",
        host=os.environ.get("HOST", "0.0.0.0"),
        port=int(os.environ.get("PORT", "5443")),
    )


if __name__ == "__main__":
    main()
