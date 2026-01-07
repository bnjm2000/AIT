#!/usr/bin/env python3
"""
Avec Inventory Tracker - Main Entry Point

This script allows you to run either the command-line interface or the web interface.
"""

import sys
import os
import argparse

def run_cli():
    """Run the command-line interface"""
    from inventory_app import InventoryManagementApp
    app = InventoryManagementApp()
    app.start()

def run_web():
    """Run the web interface"""
    try:
        from app import app, init_data_manager
        print("Starting Avec Inventory Tracker Web Interface...")
        print("Access the application at: http://192.168.0.209:80")
        print("Press Ctrl+C to stop the server")
        
        # Initialize data manager
        init_data_manager()
        
        # Run Flask app
        app.run(debug=False, host='192.168.0.209', port=80)
    except ImportError as e:
        print(f"Error: Missing required dependencies for web interface: {e}")
        print("Please install Flask and Flask-CORS:")
        print("pip install flask flask-cors")
        sys.exit(1)
    except Exception as e:
        print(f"Error starting web interface: {e}")
        sys.exit(1)

def main():
    parser = argparse.ArgumentParser(
        description='Avec Inventory Tracker - Event Inventory Management System'
    )
    parser.add_argument(
        '--interface', 
        choices=['cli', 'web'], 
        default='web',
        help='Choose the interface to run (default: web)'
    )
    parser.add_argument(
        '--data-folder',
        help='Specify the data folder path'
    )
    
    args = parser.parse_args()
    
    # Set data folder if specified
    if args.data_folder:
        if not os.path.isdir(args.data_folder):
            print(f"Error: Data folder '{args.data_folder}' does not exist.")
            sys.exit(1)
        
        with open('data_folder.txt', 'w') as f:
            f.write(args.data_folder)
        print(f"Data folder set to: {args.data_folder}")
    
    # Run the appropriate interface
    if args.interface == 'cli':
        print("Starting Command Line Interface...")
        run_cli()
    else:
        run_web()

if __name__ == "__main__":
    main()