import os
import sys
import re
import json
import getpass
from collections import defaultdict

from models import User, InventoryItem, Container, Event, LogEntry, hash_password, get_current_date, parse_date_input, format_date_output, dates_overlap
from data_manager import DataManager
from utils import clear_screen, pause, play_sound, get_state_color, get_colored_item_description, sort_items_for_display, group_items_by_model

class InventoryManagementApp:
    def __init__(self):
        self.data_folder = ''
        self.data_manager = None
        self.current_user = None

    def start(self):
        self.setup_data_folder()
        self.authenticate_user()
        self.main_menu()

    def setup_data_folder(self):
        if os.path.exists('data_folder.txt'):
            with open('data_folder.txt', 'r') as f:
                self.data_folder = f.read().strip()
            if not os.path.isdir(self.data_folder):
                print("Data folder not found or inaccessible.")
                self.prompt_data_folder()
            else:
                self.data_manager = DataManager(self.data_folder)
                self.data_manager.setup_data_folder()
                self.data_manager.check_and_initialize_files()
                self.data_manager.load_all_data()
        else:
            self.prompt_data_folder()

    def prompt_data_folder(self):
        while True:
            folder = input("Please specify the data folder path: ").strip()
            if os.path.isdir(folder):
                self.data_folder = folder
                with open('data_folder.txt', 'w') as f:
                    f.write(self.data_folder)
                self.data_manager = DataManager(self.data_folder)
                self.data_manager.setup_data_folder()
                self.data_manager.check_and_initialize_files()
                self.data_manager.load_all_data()
                break
            else:
                print("Invalid folder path. Please try again.")

    def authenticate_user(self):
        clear_screen()
        print("Welcome to Avec Inventory Tracker.")
        while True:
            username = input("Username: ").strip()
            password = getpass.getpass("Password: ").strip()
            if username in self.data_manager.users:
                user = self.data_manager.users[username]
                hashed_input = hash_password(password, user.salt)
                if hashed_input == user.password_hash:
                    self.current_user = user
                    self.log_action(f"User {username} logged in.")
                    return
            print("Invalid username or password. Please try again.")

    def main_menu(self):
        while True:
            clear_screen()
            print("Welcome to Avec Inventory Tracker.")
            print("1. Add event")
            print("2. Edit <Event number>")
            print("3. Prepare <Event number>")
            print("4. Return <Event number>")
            print("5. Transfer")
            print("6. List events")
            print("7. View <Event number>")
            print("8. Find <Event keyword>")
            print("9. Maintain <Asset ID OR S/N>")
            print("10. Info <Asset ID OR S/N>")
            print("11. Asset Check")
            print("12. Delete <Event number>")
            print("13. Log")
            print("14. Exit")
            print("\nRecent Events:")

            event_list = sorted(self.data_manager.events.values(), key=lambda e: e.event_id, reverse=True)
            for event in event_list[0:10]:
                state_color = get_state_color(event.state)
                date_range = f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
                print(f"{state_color}Event ID: {event.event_id} | [{date_range}] {event.name} | State: {event.state}\033[0m")
            
            choice = input("What would you like to do: ").strip()

            if choice.lower() == 'config' and self.current_user.is_admin:
                self.config_menu()
            elif choice == '1' or choice.lower() == 'add event':
                self.add_event()
            elif choice.startswith('2') or choice.lower().startswith('edit'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.edit_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('3') or choice.lower().startswith('prepare'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.prepare_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('4') or choice.lower().startswith('return'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.return_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice == '5' or choice.lower() == 'transfer':
                self.transfer_event()
            elif choice == '6' or choice.lower() == 'list events':
                self.list_events()
            elif choice.startswith('7') or choice.lower().startswith('view'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.view_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('8') or choice.lower().startswith('find'):
                parts = choice.split(maxsplit=1)
                if len(parts) == 2:
                    self.find_event(parts[1])
                else:
                    print("Invalid command.")
                    pause()
            elif choice.startswith('9') or choice.lower().startswith('maintain'):
                parts = choice.split(maxsplit=1)
                if len(parts) == 2:
                    self.maintain_asset(parts[1])
                else:
                    self.maintain_asset()
            elif choice.startswith('10') or choice.lower().startswith('info'):
                parts = choice.split(maxsplit=1)
                if len(parts) == 2:
                    self.show_info(parts[1])
                else:
                    print("Invalid command.")
                    pause()
            elif choice == '11' or choice.lower() == 'asset check':
                self.asset_check()
            elif choice.startswith('12') or choice.lower().startswith('delete'):
                parts = choice.split()
                if len(parts) == 2:
                    try:
                        self.delete_event(int(parts[1]))
                    except ValueError:
                        print("Invalid event number.")
                        pause()
                else:
                    print("Invalid command.")
                    pause()
            elif choice == '13' or choice.lower() == 'log':
                self.show_logs()
            elif choice == '14' or choice.lower() == 'exit':
                self.log_action(f"User {self.current_user.username} logged out.")
                print("Goodbye!")
                sys.exit()
            else:
                print("Invalid option.")
                pause()

    def config_menu(self):
        while True:
            clear_screen()
            print("Configuration Menu:")
            print("1. Add Equipment/Assets")
            print("2. Add/Edit Container")
            print("3. Edit Equipment/Assets")
            print("4. Search Asset")
            print("5. Delete Asset or Container")
            print("6. Add/Edit User")
            print("7. View Asset History")
            print("8. Maintain Asset")
            print("9. Back to Main Menu")
            choice = input("Select an option: ").strip()
            if choice == '1':
                self.add_equipment()
            elif choice == '2':
                self.add_edit_container()
            elif choice == '3':
                self.edit_equipment()
            elif choice == '4':
                self.search_asset()
            elif choice == '5':
                self.delete_asset_or_container()
            elif choice == '6':
                self.add_edit_user()
            elif choice == '7':
                identifier = input("Enter Asset ID or Serial Number or Container ID: ").strip()
                self.show_history(identifier)
            elif choice == '8':
                identifier = input("Enter Asset ID or Serial Number: ").strip()
                self.maintain_asset(identifier)
            elif choice == '9':
                break
            else:
                print("Invalid option.")
                pause()

    # Utility methods
    def find_item_by_id_or_serial(self, id_or_serial):
        if id_or_serial in self.data_manager.inventory:
            return self.data_manager.inventory[id_or_serial]
        else:
            for item in self.data_manager.inventory.values():
                if item.serial_number and item.serial_number.lower() == id_or_serial.lower():
                    return item
        return None

    def log_action(self, action):
        timestamp = get_current_date()
        log_entry = LogEntry(timestamp, self.current_user.username, action)
        self.data_manager.logs.append(log_entry)
        self.data_manager.save_logs()

    def search_items_by_keywords(self, keywords):
        keywords = keywords.lower().split()
        results = []
        for item in self.data_manager.inventory.values():
            if item.is_missing or item.is_ooc:
                continue
            searchable_text = f"{item.brand} {item.model_number} {item.description}".lower()
            if any(keyword in searchable_text for keyword in keywords):
                results.append(item)
        return results

    def get_event_by_asset(self, asset_id):
        for event in self.data_manager.events.values():
            if asset_id in event.prepared_items and asset_id not in event.returned_items:
                return event
        return None

    def get_available_quantity(self, model_description, start_date, end_date, exclude_event_id=None):
        total_quantity = sum(
            1 for item in self.data_manager.inventory.values()
            if not item.is_missing and not item.is_ooc and
            f"[{item.department_code}] {item.brand} {item.model_number} {item.description}" == model_description
        )

        allocated_quantity = 0
        for event in self.data_manager.events.values():
            if exclude_event_id and event.event_id == exclude_event_id:
                continue
            if dates_overlap(event.start_date, event.end_date, start_date, end_date):
                for model in event.asset_models:
                    if model['model_description'] == model_description:
                        allocated_quantity += model['quantity']

        available_quantity = total_quantity - allocated_quantity
        return available_quantity, total_quantity

    def get_clashing_events(self, model_description, start_date, end_date, exclude_event_id=None):
        clashing_events = []
        total_required = 0

        for event in self.data_manager.events.values():
            if exclude_event_id and event.event_id == exclude_event_id:
                continue

            if dates_overlap(event.start_date, event.end_date, start_date, end_date):
                for model in event.asset_models:
                    if model['model_description'] == model_description:
                        clashing_events.append(event)
                        total_required += model['quantity']
                        break

        total_inventory = sum(
            1 for item in self.data_manager.inventory.values()
            if not item.is_missing and not item.is_ooc and
            f"[{item.department_code}] {item.brand} {item.model_number} {item.description}" == model_description
        )

        drought = (total_required + 1) > total_inventory
        return drought, clashing_events

    # Event management methods
    def add_event(self):
        name = input("What is the name of the show? ").strip()
        start_date_input = input("Enter the start date (YYYY/MM/DD): ").strip()
        end_date_input = input("Enter the end date (YYYY/MM/DD, leave blank if same as start date): ").strip() or start_date_input

        start_date = parse_date_input(start_date_input)
        end_date = parse_date_input(end_date_input)

        if not start_date or not end_date:
            print("Invalid date format.")
            pause()
            return

        event_id = max(self.data_manager.events.keys(), default=0) + 1
        asset_models = []
        added_items = {}
        last_action = []

        event = Event(event_id, name, start_date, end_date, asset_models)
        self.add_edit_event(event_id, event, start_date, end_date, asset_models, added_items, last_action)

        self.data_manager.events[event_id] = event
        self.data_manager.save_event(event)
        self.log_action(f"Added event {event_id}: {name}.")
        print("Event added successfully.")
        pause()

    def edit_event(self, event_id):
        event = self.data_manager.events.get(event_id)
        if not event:
            print("Event not found.")
            pause()
            return

        print(f"Editing Event {event_id}: [{format_date_output(event.start_date)} to {format_date_output(event.end_date)}] {event.name}")
        name = input(f"New name (leave blank to keep current): ").strip()
        start_date_input = input(f"New start date (YYYY/MM/DD, leave blank to keep current): ").strip()
        end_date_input = input(f"New end date (YYYY/MM/DD, leave blank to keep current): ").strip()

        if name:
            event.name = name
            for asset_id in event.prepared_items:
                item = self.data_manager.inventory.get(asset_id)
                if item and not asset_id.startswith('loan|') and not asset_id.startswith('misc|'):
                    item.current_location = event.name
                    self.data_manager.save_inventory()

        if start_date_input:
            new_start_date = parse_date_input(start_date_input)
            if new_start_date:
                event.start_date = new_start_date
            else:
                print("Invalid start date format.")
                pause()
                return
        if end_date_input:
            new_end_date = parse_date_input(end_date_input)
            if new_end_date:
                event.end_date = new_end_date
            else:
                print("Invalid end date format.")
                pause()
                return
        
        start_date = event.start_date
        end_date = event.end_date

        asset_models = event.asset_models
        added_items = {model['model_description']: model['quantity'] for model in asset_models}
        last_action = []

        self.add_edit_event(event_id, event, start_date, end_date, asset_models, added_items, last_action)

        self.data_manager.events[event_id] = event
        self.data_manager.save_event(event)
        self.log_action(f"Edited event {event_id}: {event.name}.")
        print("Event edited successfully.")
        pause()

    def view_event(self, event_id):
        event = self.data_manager.events.get(event_id)
        if not event:
            print("Event ID not found.")
            pause()
            return

        clear_screen()
        date_range = format_date_output(event.start_date) if event.start_date == event.end_date else f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
        print(f"[{date_range}] {event.name}\n")
        state_color = get_state_color(event.state)
        print(f"Event State: {state_color}{event.state}\033[0m\n")

        # Build summary
        planned_summary = {}
        for model in event.asset_models:
            planned_summary[model['model_description']] = model['quantity']

        prepared_summary = {}
        for prepared_item in event.prepared_items:
            if prepared_item.startswith('[LOAN]') or prepared_item.startswith('[MISC]'):
                parts = prepared_item.split(';')
                model_description = parts[0]
                quantity = int(parts[1]) if len(parts) > 1 else 1
                prepared_summary[model_description] = prepared_summary.get(model_description, 0) + quantity
            else:
                item = self.data_manager.inventory.get(prepared_item)
                if item:
                    model_description = f"[{item.department_code}] {item.brand} {item.model_number} {item.description}"
                    prepared_summary[model_description] = prepared_summary.get(model_description, 0) + 1

        final_summary = dict(planned_summary)
        for model_description, prepared_qty in prepared_summary.items():
            if model_description in final_summary:
                final_summary[model_description] = max(final_summary[model_description], prepared_qty)
            else:
                final_summary[model_description] = prepared_qty

        display_items = [{'model_description': k, 'quantity': v} for k, v in final_summary.items()]
        display_items = sort_items_for_display(display_items)
        print("Item Summary:\n")
        for item in display_items:
            model_description = item['model_description']
            quantity = item['quantity']
            colored_description = get_colored_item_description(model_description)
            print(f"{quantity}x\t{colored_description}")
        pause()

    def delete_event(self, event_id):
        event = self.data_manager.events.get(event_id)
        if not event:
            print("Event not found.")
            play_sound(success=False)
            pause()
            return

        if not self.current_user.is_admin:
            print("You do not have permission to delete events.")
            play_sound(success=False)
            pause()
            return

        confirm = input(f"Are you sure you want to delete Event {event_id}: {event.name}? (y/n): ").strip().lower()
        if confirm != 'y':
            print("Deletion cancelled.")
            play_sound(success=False)
            pause()
            return

        try:
            self.data_manager.backup_event_file(event_id)

            assets_reset = []
            
            # Reset assets from prepared_items
            for asset_id in event.prepared_items.copy():
                if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]') or asset_id.startswith('[MODEL]')):
                    item = self.data_manager.inventory.get(asset_id)
                    if item:
                        old_location = item.current_location
                        item.current_location = item.default_location or ""
                        assets_reset.append(f"{asset_id} (from '{old_location}' to '{item.current_location or 'Store'}')")
                        self.log_action(f"Reset location for asset {asset_id} due to deletion of Event {event_id}.")

            # Reset assets from actually_prepared (in case there are any not in prepared_items)
            if hasattr(event, 'actually_prepared'):
                for asset_id in event.actually_prepared.copy():
                    if not (asset_id.startswith('[LOAN]') or asset_id.startswith('[MISC]')):
                        item = self.data_manager.inventory.get(asset_id)
                        if item and asset_id not in event.prepared_items:
                            old_location = item.current_location
                            item.current_location = item.default_location or ""
                            assets_reset.append(f"{asset_id} (from '{old_location}' to '{item.current_location or 'Store'}')")
                            self.log_action(f"Reset location for asset {asset_id} due to deletion of Event {event_id}.")

            self.data_manager.save_inventory()
            del self.data_manager.events[event_id]
            self.data_manager.delete_event_file(event_id)
            
            if assets_reset:
                self.log_action(f"Deleted Event {event_id}: {event.name}. Reset {len(assets_reset)} asset locations.")
                print(f"\nReset locations for {len(assets_reset)} assets:")
                for reset_info in assets_reset[:10]:  # Show first 10
                    print(f"  - {reset_info}")
                if len(assets_reset) > 10:
                    print(f"  ... and {len(assets_reset) - 10} more")
            else:
                self.log_action(f"Deleted Event {event_id}: {event.name}.")

            print(f"Event {event_id}: {event.name} has been deleted successfully.")
            play_sound(success=True)
        except Exception as e:
            print(f"An error occurred while deleting the event: {e}")
            self.log_action(f"Error deleting Event {event_id}: {e}")
            play_sound(success=False)
        finally:
            pause()

    def list_events(self):
        event_list = sorted(self.data_manager.events.values(), key=lambda e: e.event_id, reverse=True)
        index = 0
        while index < len(event_list):
            for event in event_list[index:index+10]:
                state_color = get_state_color(event.state)
                date_range = f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
                print(f"{state_color}Event ID: {event.event_id} | [{date_range}] {event.name} | State: {event.state}\033[0m")

            index += 10
            if index < len(event_list):
                cont = input("Show more? (y/n): ").strip().lower()
                if cont != 'y':
                    break
        pause()

    def find_event(self, keyword):
        keyword = keyword.lower()
        results = [event for event in self.data_manager.events.values() if keyword in event.name.lower()]
        if results:
            for event in results:
                if event.start_date == event.end_date:
                    date_range = format_date_output(event.start_date)
                else:
                    date_range = f"{format_date_output(event.start_date)} to {format_date_output(event.end_date)}"
                print(f"Event ID: {event.event_id} | [{date_range}] {event.name}")
        else:
            print("No matching events found.")
        pause()

    def show_info(self, identifier):
        item = self.find_item_by_id_or_serial(identifier)
        if not item:
            print("Asset not found.")
            play_sound(success=False)
            pause()
            return

        print(f"\nAsset ID: {item.asset_id}")
        print(f"Brand: {item.brand}")
        print(f"Model Number: {item.model_number}")
        print(f"Description: {item.description}")
        print(f"Serial Number: {item.serial_number}")
        print(f"Department Code: {item.department_code}")
        print(f"Default Location: {item.default_location}")
        print(f"Current Location: {item.current_location}")
        is_missing = 'Yes' if item.is_missing else 'No'
        is_ooc = 'Yes' if item.is_ooc else 'No'
        missing_color = '\033[91m' if item.is_missing else '\033[0m'
        ooc_color = '\033[91m' if item.is_ooc else '\033[0m'
        print(f"Is Missing: {missing_color}{is_missing}\033[0m")
        print(f"Is Out of Commission: {ooc_color}{is_ooc}\033[0m\n")

        print("Maintenance Logs:")
        if item.maintenance_logs:
            for log in item.maintenance_logs[-10:]:
                print(f"{log}")
        else:
            print("No maintenance logs available.")

        # Event History
        event_history = []
        for evt in sorted(self.data_manager.events.values(), key=lambda e: e.event_id, reverse=True):
            if item.asset_id in evt.prepared_items:
                event_history.append(evt)
                if len(event_history) == 10:
                    break

        print("\nEvent History:")
        if event_history:
            for evt in event_history:
                state_color = get_state_color(evt.state)
                date_range = format_date_output(evt.start_date) if evt.start_date == evt.end_date else f"{format_date_output(evt.start_date)} to {format_date_output(evt.end_date)}"
                print(f"{state_color}Event ID: {evt.event_id} \t| [{date_range}] {evt.name} | State: {evt.state}\033[0m")
        else:
            print("No event history available.")
        pause()

    def show_logs(self):
        for log in self.data_manager.logs[-1000:]:
            print(f"{log.timestamp}\t{log.user}\t{log.action}")
        pause()

    # Asset management methods
    def add_equipment(self):
        while True:
            brand = input("Brand (type 'exit' to return): ").strip()
            if brand.lower() == 'exit':
                break
            model_number = input("Model number: ").strip().upper()
            description = input("Description (optional): ").strip()
            department_code = input("Department code (e.g., AX, LX): ").strip().upper()
            if not department_code:
                department_code = 'UN'
            quantity = input("How many items to add: ").strip()
            if not quantity.isdigit():
                print("Invalid quantity.")
                continue
            quantity = int(quantity)
            existing_items = [item for item in self.data_manager.inventory.values() if item.model_number == model_number]
            next_number = len(existing_items) + 1
            for i in range(quantity):
                asset_id = f"{model_number}#{next_number:02d}"
                serial_number = input(f"Serial number for {asset_id} (optional): ").strip()
                is_missing = input(f"Is {asset_id} missing? (y/n): ").strip().lower() == 'y'
                item = InventoryItem(
                    asset_id=asset_id,
                    brand=brand,
                    model_number=model_number,
                    serial_number=serial_number,
                    description=description,
                    is_missing=is_missing,
                    is_ooc=False,
                    maintenance_logs=[],
                    department_code=department_code,
                    default_location="Store",
                    current_location=''
                )
                self.data_manager.inventory[asset_id] = item
                self.log_action(f"Added equipment {asset_id}.")
                next_number += 1
            self.data_manager.save_inventory()
            print(f"Added {quantity} items.")
            pause()
            break

    def search_asset(self):
        keywords = input("Enter keywords to search: ").strip().lower().split()
        if not keywords:
            print("No keywords entered.")
            pause()
            return
        results = []
        for item in self.data_manager.inventory.values():
            searchable_text = f"{item.brand} {item.model_number} {item.description}".lower()
            if all(keyword in searchable_text for keyword in keywords):
                results.append(item)
        if results:
            for item in results:
                print(f"{item.asset_id}: {item.brand} {item.model_number} {item.description}")
        else:
            print("No matching assets found.")
        pause()

    def maintain_asset(self, identifier=None):
        maintenance_list = []
        message = ""
        new_location = None
        mark_ooc = 'n'
        unmark_ooc = 'n'

        if identifier:
            item = self.find_item_by_id_or_serial(identifier)
            if item:
                maintenance_list.append(item.asset_id)
            else:
                print("Asset not found.")
                pause()
                return

        print("Enter Asset IDs, Serial Numbers, or Container IDs to add to maintenance (type 'done' when finished):")
        
        while True:
            clear_screen()
            
            print("Maintenance Preparation")
            if maintenance_list:
                print("\nAssets selected for maintenance:")
                for asset_id in maintenance_list:
                    item = self.data_manager.inventory.get(asset_id)
                    if item:
                        print(f"{asset_id}: {item.brand} {item.model_number} {item.description}")
            
            if message:
                print(f"\n{message}")
            
            if identifier:
                user_input = 'done'
                identifier = None
            else:
                user_input = input("\nEnter Asset ID, Serial Number, or Container ID (or 'done' to finish): ").strip()

            if user_input.lower() == 'done':
                break
            elif user_input in self.data_manager.containers:
                container = self.data_manager.containers[user_input]
                for asset_id in container.asset_ids:
                    if asset_id in maintenance_list:
                        message = f"Asset {asset_id} is already in the maintenance list."
                        play_sound(success=False)
                        continue
                    item = self.data_manager.inventory.get(asset_id)
                    if item:
                        maintenance_list.append(asset_id)
                        message = f"Added {asset_id} from container {user_input} for maintenance."
                        play_sound(success=True)
                    else:
                        message = f"Asset {asset_id} not found in inventory."
                        play_sound(success=False)
            else:
                item = self.find_item_by_id_or_serial(user_input)
                if item:
                    if item.asset_id in maintenance_list:
                        message = f"Asset {item.asset_id} is already in the maintenance list."
                        play_sound(success=False)
                    else:
                        maintenance_list.append(item.asset_id)
                        message = f"Added {item.asset_id} for maintenance."
                        play_sound(success=True)
                else:
                    message = "Asset not found."
                    play_sound(success=False)

        if maintenance_list:
            log_entry = input("\nEnter maintenance log entry: ").strip()
            current_date = get_current_date()
            
            if any(keyword in log_entry.lower() for keyword in ["servicing", "repair", "spoilt", "faulty"]):
                update_location = input("Do you want to update the location of these assets? (y/n): ").strip().lower()
                if update_location == 'y':
                    new_location = input("Enter the new location: ").strip()

            if any(keyword in log_entry.lower() for keyword in ["spoilt", "faulty", "check"]):
                mark_ooc = input("Do you want to mark these items as Out of Commission (OOC)? (y/n): ").strip().lower()
            elif any(keyword in log_entry.lower() for keyword in ["fixed", "repaired", "replaced"]):
                unmark_ooc = input("Do you want to unmark these items from being Out of Commission (OOC)? (y/n): ").strip().lower()
            else:
                mark_ooc = 'n'
                unmark_ooc = 'n'

            for asset_id in maintenance_list:
                item = self.data_manager.inventory.get(asset_id)
                if item:
                    entry = f"{current_date}\t{self.current_user.username}\t{log_entry}"
                    item.maintenance_logs.append(entry)
                    
                    if new_location:
                        item.current_location = new_location

                    if mark_ooc == 'y':
                        item.is_ooc = True
                    if unmark_ooc == 'y':
                        item.is_ooc = False

                    self.data_manager.save_inventory()
                    message = f"Maintenance logged for {item.asset_id}."
                    play_sound(success=True)
                else:
                    message = f"Asset {asset_id} not found in inventory."
                    play_sound(success=False)

            print("\nMaintenance completed for all selected assets.")
        else:
            print("\nNo assets selected for maintenance.")

        pause()

    def asset_check(self):
        clear_screen()
        print("Asset Check")
        initial_input = input("Enter an Asset ID or Serial Number to start (or 'exit' to cancel): ").strip()
        if initial_input.lower() == 'exit':
            return
        item = self.find_item_by_id_or_serial(initial_input)
        if not item:
            print("Asset ID or Serial Number not found.")
            pause()
            return
        brand = item.brand
        model_number = item.model_number

        items_to_check = [i for i in self.data_manager.inventory.values() if i.brand == brand and i.model_number == model_number]
        items_dict = {i.asset_id: i for i in items_to_check}

        print(f"\nChecking items for {brand} {model_number} {item.description}\n")
        self.display_items_list(items_dict.values())

        checked_items = set()

        while True:
            user_input = input("\nEnter Asset ID or Serial Number (or 'done' to finish, 'exit' to cancel): ").strip()
            if user_input.lower() == 'done':
                break
            elif user_input.lower() == 'exit':
                print("Asset check cancelled.")
                pause()
                return
            found_item = self.find_item_by_id_or_serial(user_input)
            if not found_item:
                print("Asset ID or Serial Number not found.")
                continue
            if found_item.asset_id not in items_dict:
                print("Item does not match the items being checked.")
                continue
            if found_item.asset_id in checked_items:
                print("Item already checked.")
                continue
            checked_items.add(found_item.asset_id)
            del items_dict[found_item.asset_id]
            print("\nRemaining items:")
            self.display_items_list(items_dict.values())

        if items_dict:
            print("\nThe following items were not found:")
            self.display_items_list(items_dict.values())
            for item in items_dict.values():
                if not item.is_missing:
                    confirm = input(f"Mark {item.asset_id} as missing? (y/n): ").strip().lower()
                    if confirm == 'y':
                        item.is_missing = True
                        print(f"{item.asset_id} marked as missing.")
                    else:
                        print(f"{item.asset_id} not marked as missing.")
                else:
                    print(f"{item.asset_id} is already marked as missing.")
            self.data_manager.save_inventory()
            print("\nInventory updated.")
        else:
            print("\nAll items accounted for.")
        pause()

    def display_items_list(self, items):
        if not items:
            print("No items to display.")
            return

        sorted_items = sort_items_for_display(items)

        print(f"{'Asset ID':<15}{'Serial Number':<20}{'Item Details'}")
        print("-" * 60)
        for item in sorted_items:
            colored_description = get_colored_item_description(f"[{item.department_code}] {item.brand} {item.model_number} {item.description}")
            print(f"{item.asset_id:<15}{item.serial_number:<20}{colored_description}")

    # Placeholder methods for complex event operations
    def add_edit_event(self, event_id, event, start_date, end_date, asset_models, added_items, last_action):
        # This is a simplified version - the full implementation would be quite long
        print("Event editing interface would go here...")
        pause()

    def prepare_event(self, event_id):
        print("Event preparation interface would go here...")
        pause()

    def return_event(self, event_id):
        print("Event return interface would go here...")
        pause()

    def transfer_event(self):
        print("Event transfer interface would go here...")
        pause()

    # Additional config methods
    def add_edit_container(self):
        print("Container management interface would go here...")
        pause()

    def edit_equipment(self):
        print("Equipment editing interface would go here...")
        pause()

    def delete_asset_or_container(self):
        print("Asset/Container deletion interface would go here...")
        pause()

    def add_edit_user(self):
        print("User management interface would go here...")
        pause()

    def show_history(self, identifier):
        print("Asset history interface would go here...")
        pause()

if __name__ == "__main__":
    app = InventoryManagementApp()
    app.start()