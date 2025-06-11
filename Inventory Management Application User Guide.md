# Inventory Management Application User Guide

Welcome to the **Avec Inventory Tracker** user guide. This guide provides detailed instructions on how to use the Inventory Management Application, including all features and prompts you will encounter while using the program.

---

## Table of Contents

1. [Introduction](#introduction)
2. [Getting Started](#getting-started)
   - [Installation](#installation)
   - [First-Time Setup](#first-time-setup)
3. [Authentication](#authentication)
4. [Main Menu](#main-menu)
5. [Event Management](#event-management)
   - [Add Event](#add-event)
   - [List Events](#list-events)
   - [Edit Event](#edit-event)
   - [Delete Event](#delete-event)
   - [Find Event](#find-event)
   - [View Event](#view-event)
6. [Asset Management](#asset-management)
   - [Add Equipment/Assets](#add-equipmentassets)
   - [Edit Equipment/Assets](#edit-equipmentassets)
   - [Delete Asset or Container](#delete-asset-or-container)
   - [Find Asset](#find-asset)
   - [View Asset History](#view-asset-history)
   - [Maintain Asset](#maintain-asset)
7. [Container Management](#container-management)
   - [Add/Edit Container](#addedit-container)
8. [User Management](#user-management)
   - [Add/Edit User](#addedit-user)
9. [Logs](#logs)
10. [Configuration Menu](#configuration-menu)
11. [Exiting the Program](#exiting-the-program)
12. [Troubleshooting](#troubleshooting)
13. [FAQs](#faqs)
14. [Contact Support](#contact-support)

---

## Introduction

The **Avec Inventory Tracker** is a command-line application designed to help you manage inventory items, events, containers, and users efficiently. The program allows you to:

- Add, edit, and delete events.
- Manage inventory items (assets) and their maintenance logs.
- Create and manage containers that hold multiple assets.
- Add and manage users with different access levels.
- Keep track of logs for auditing purposes.

---

## Getting Started

### Installation

1. **Prerequisites:**

   - Python 3.x installed on your system.
   - Basic understanding of using the command line.

2. **Download the Program:**

   Save the provided `inventory_management.py` script to a directory of your choice.

### First-Time Setup

When you run the program for the first time, it will prompt you to specify a data folder where all the `.csv` data files will be stored.

**Prompt:**

```
Please specify the data folder path:
```

- **Action:** Enter the full path to the folder you want to use for storing data files.
- **Example:** `/Users/username/Documents/InventoryData`

If the folder doesn't exist, create it before running the program.

---

## Authentication

Upon starting the program, you will be greeted with a login prompt.

**Prompts:**

```
Welcome to Avec Inventory Tracker.
Username:
Password:
```

- **Default Admin Credentials (if running for the first time):**
  - **Username:** `admin`
  - **Password:** `admin`

---

## Main Menu

After successful authentication, the main menu will be displayed.

**Prompt:**

```
Welcome to Avec Inventory Tracker. What would you like to do?
1. Add
2. List
3. Edit <Event number>
4. History <Asset ID OR S/N>
5. Delete <Event number>
6. Find <Event keyword>
7. View <Event number>
8. Log
9. Maintain <Asset ID OR S/N>
10. exit
```

**Available Commands:**

- **Add:** Create a new event.
- **List:** Display a list of existing events.
- **Edit <Event number>:** Edit an existing event by its ID.
- **History <Asset ID OR S/N>:** View the history of a specific asset.
- **Delete <Event number>:** Delete an event by its ID.
- **Find <Event keyword>:** Search for events by keyword.
- **View <Event number>:** View details of an event by its ID.
- **Log:** Display the system logs.
- **Maintain <Asset ID OR S/N>:** Add a maintenance log to an asset.
- **exit:** Exit the application.

**Note:** If you are an admin, you can access the configuration menu by typing `config`.

---

## Event Management

### Add Event

To add a new event:

1. **Select Add:**

   Type `1` or `add` at the main menu prompt.

2. **Provide Event Details:**

   **Prompts:**

   ```
   What is the name of the show?
   When is the show (in YYYYMMDD)?
   ```

   - **Name:** Enter the event name.
   - **Date:** Enter the event date in `YYYYMMDD` format.

3. **Add Assets to Event:**

   **Prompt:**

   ```
   Start adding items (type 'done' to finish, 'undo' to remove last item, 'remove <Asset ID or Serial Number>' to remove specific item):
   Enter Asset ID or Serial Number or Command:
   ```

   - Enter the **Asset ID** or **Serial Number** of the item to add.
   - **Commands:**
     - `done`: Finish adding items.
     - `undo`: Remove the last added item.
     - `remove <Asset ID or Serial Number>`: Remove a specific item.

4. **Feedback:**

   After each entry, the program will provide feedback:

   - **Success:**

     ```
     Added [Brand] [Model Number] [Description]
     ```

   - **Error:**

     ```
     Asset ID or Serial Number or Container ID not found.
     ```

5. **Finalize Event:**

   After typing `done`, the event summary will be displayed.

   **Example Summary:**

   ```
   [20240925] Conference
   Item Summary:
   
   [AX]  2x  Shure ULXD2 Handheld Microphone
   [LX]  1x  ETC Source Four LED
   ```

---

### List Events

To list existing events:

1. **Select List:**

   Type `2` or `list` at the main menu prompt.

2. **Events Displayed:**

   Events are displayed in pages of 10.

   **Example Output:**

   ```
   Event ID: 1 | [20240925] Conference
   Event ID: 2 | [20241015] Annual Meeting
   ```

3. **Pagination Prompt:**

   If there are more events:

   ```
   Show more? (y/n):
   ```

   - Type `y` to display the next page.
   - Type `n` to return to the main menu.

---

### Edit Event

To edit an existing event:

1. **Select Edit:**

   Type `3 <Event ID>` or `edit <Event ID>` at the main menu prompt.

   **Example:**

   ```
   edit 1
   ```

2. **Edit Event Details:**

   **Prompts:**

   ```
   Editing Event 1: [20240925] Conference
   Name [Conference]:
   Date [20240925]:
   ```

   - Press **Enter** to keep the current value or enter a new one.

3. **Edit Event Assets:**

   **Prompt:**

   ```
   Editing items (type 'done' to finish, 'remove <Asset ID or Serial Number>' to remove specific item):
   Enter Asset ID or Serial Number or Command:
   ```

   - Add or remove assets as needed using the same commands as in the **Add Event** section.

4. **Finalize Edits:**

   Type `done` when finished.

---

### Delete Event

To delete an event:

1. **Select Delete:**

   Type `5 <Event ID>` or `delete <Event ID>` at the main menu prompt.

   **Example:**

   ```
   delete 1
   ```

2. **Confirmation Prompt:**

   ```
   Confirm delete of [20240925] Conference? (Yes/No):
   ```

   - Type `Yes` to confirm deletion.
   - Type `No` to cancel.

3. **Feedback:**

   ```
   Event deleted.
   ```

---

### Find Event

To find events by keyword:

1. **Select Find:**

   Type `6 <Event keyword>` or `find <Event keyword>` at the main menu prompt.

   **Example:**

   ```
   find Conference
   ```

2. **Results Displayed:**

   ```
   Event ID: 1 | [20240925] Conference
   ```

---

### View Event

To view an event's details:

1. **Select View:**

   Type `7 <Event ID>` or `view <Event ID>` at the main menu prompt.

   **Example:**

   ```
   view 1
   ```

2. **Event Summary Displayed:**

   ```
   [20240925] Conference
   Item Summary:
   
   [AX]  2x  Shure ULXD2 Handheld Microphone
   [LX]  1x  ETC Source Four LED
   ```

---

## Asset Management

### Add Equipment/Assets

*Admin access required.*

1. **Access Configuration Menu:**

   Type `config` at the main menu prompt.

2. **Select Add Equipment/Assets:**

   **Prompt:**

   ```
   Configuration Menu:
   1. Add Equipment/Assets
   ...
   Select an option:
   ```

   Type `1`.

3. **Provide Asset Details:**

   **Prompts:**

   ```
   Brand (type 'exit' to return):
   Model number:
   Description (optional):
   Department code (e.g., AX, LX):
   How many items to add:
   ```

   - **Brand:** Enter the manufacturer name or type `exit` to return to the previous menu.
   - **Model Number:** Enter the model number.
   - **Description:** Enter a description (optional).
   - **Department Code:** Enter the department code (e.g., `AX` for Audio).
   - **Quantity:** Enter the number of items to add.

4. **Enter Serial Numbers and Missing Status:**

   For each item:

   **Prompts:**

   ```
   Serial number for [Asset ID] (optional):
   Is [Asset ID] missing? (y/n):
   ```

   - **Serial Number:** Enter the serial number (optional).
   - **Missing Status:** Type `y` if the item is missing, `n` otherwise.

5. **Feedback:**

   ```
   Added [Quantity] items.
   ```

---

### Edit Equipment/Assets

*Admin access required.*

1. **Access Configuration Menu:**

   Type `config` at the main menu prompt.

2. **Select Edit Equipment/Assets:**

   **Prompt:**

   ```
   Configuration Menu:
   ...
   3. Edit Equipment/Assets
   ...
   Select an option:
   ```

   Type `3`.

3. **Provide Asset ID:**

   **Prompt:**

   ```
   Asset ID to edit:
   ```

4. **Edit Asset Details:**

   **Prompts:**

   ```
   Editing [Asset ID]: [Brand] [Model Number] [Description]
   Brand [Current Brand]:
   Model number [Current Model Number]:
   Description [Current Description]:
   Serial number [Current Serial Number]:
   Department code [Current Department Code]:
   Is missing? (y/n):
   ```

   - Enter new values or press **Enter** to keep current values.

5. **Feedback:**

   ```
   Item updated.
   ```

---

### Delete Asset or Container

*Admin access required.*

1. **Access Configuration Menu:**

   Type `config` at the main menu prompt.

2. **Select Delete Asset or Container:**

   **Prompt:**

   ```
   Configuration Menu:
   ...
   5. Delete Asset or Container
   ...
   Select an option:
   ```

   Type `5`.

3. **Choose to Delete Asset or Container:**

   **Prompt:**

   ```
   Delete (1) Asset or (2) Container?
   ```

   - Type `1` for Asset or `2` for Container.

4. **Provide ID to Delete:**

   **For Asset:**

   ```
   Asset ID to delete:
   ```

   **For Container:**

   ```
   Container ID to delete:
   ```

5. **Confirmation Prompt:**

   ```
   Confirm delete of [Asset ID/Container ID]? (y/n):
   ```

6. **Feedback:**

   ```
   Asset deleted.
   ```

   or

   ```
   Container deleted.
   ```

---

### Find Asset

*Admin access required.*

1. **Access Configuration Menu:**

   Type `config` at the main menu prompt.

2. **Select Find Asset:**

   **Prompt:**

   ```
   Configuration Menu:
   ...
   4. Find Asset
   ...
   Select an option:
   ```

   Type `4`.

3. **Enter Search Keyword:**

   **Prompt:**

   ```
   Enter keyword to search:
   ```

4. **Results Displayed:**

   ```
   [Asset ID]: [Brand] [Model Number] [Description]
   ```

---

### View Asset History

1. **Select History:**

   Type `4 <Asset ID or Serial Number>` or `history <Asset ID or Serial Number>` at the main menu prompt.

   **Example:**

   ```
   history ULXD2#01
   ```

2. **History Displayed:**

   ```
   History for ULXD2#01: Shure ULXD2 Handheld Microphone
   
   Maintenance Logs:
   [Date] [Username] [Log Entry]
   
   Events:
   [20240925] Conference
   [20241015] Annual Meeting
   ```

---

### Maintain Asset

1. **Select Maintain:**

   Type `9 <Asset ID or Serial Number>` or `maintain <Asset ID or Serial Number>` at the main menu prompt.

   **Example:**

   ```
   maintain ULXD2#01
   ```

2. **Enter Maintenance Log:**

   **Prompt:**

   ```
   Input log:
   ```

3. **Feedback:**

   ```
   Maintenance logged.
   [Timestamp]  [Username]  [Log Entry]
   ```

---

## Container Management

### Add/Edit Container

*Admin access required.*

1. **Access Configuration Menu:**

   Type `config` at the main menu prompt.

2. **Select Add/Edit Container:**

   **Prompt:**

   ```
   Configuration Menu:
   2. Add/Edit Container
   ...
   Select an option:
   ```

   Type `2`.

3. **Provide Container ID:**

   **Prompt:**

   ```
   Container ID:
   ```

   - If the container exists, you'll be editing it.
   - If not, a new container will be created.

4. **Add or Remove Assets:**

   **Prompt:**

   ```
   Enter Asset ID or Serial Number to add (type 'done' to finish):
   ```

   - **Add Assets:** Enter the Asset ID or Serial Number.
   - **Remove Assets:** Type `remove <Asset ID or Serial Number>`.

5. **Feedback:**

   - **Adding Asset:**

     ```
     Added [Asset ID] to container.
     ```

   - **Removing Asset:**

     ```
     Removed [Asset ID] from container.
     ```

---

## User Management

### Add/Edit User

*Admin access required.*

1. **Access Configuration Menu:**

   Type `config` at the main menu prompt.

2. **Select Add/Edit User:**

   **Prompt:**

   ```
   Configuration Menu:
   ...
   6. Add/Edit User
   ...
   Select an option:
   ```

   Type `6`.

3. **Provide Username:**

   **Prompt:**

   ```
   Enter username:
   ```

4. **Add or Edit User:**

   - If the user exists, you'll edit their details.
   - If not, a new user will be created.

5. **Provide User Details:**

   **For Existing User:**

   ```
   Editing existing user.
   Enter new password (leave blank to keep current):
   Is admin? (y/n):
   ```

   **For New User:**

   ```
   Creating new user.
   Enter password:
   Is admin? (y/n):
   ```

6. **Feedback:**

   - **User Updated:**

     ```
     User updated.
     ```

   - **User Created:**

     ```
     User created.
     ```

---

## Logs

To view system logs:

1. **Select Log:**

   Type `8` or `log` at the main menu prompt.

2. **Logs Displayed:**

   ```
   [Timestamp]  [Username]  [Action]
   ```

---

## Configuration Menu

*Admin access required.*

To access the configuration menu:

1. **Type `config` at the main menu prompt.**

2. **Configuration Options:**

   ```
   Configuration Menu:
   1. Add Equipment/Assets
   2. Add/Edit Container
   3. Edit Equipment/Assets
   4. Find Asset
   5. Delete Asset or Container
   6. Add/Edit User
   7. View Asset History
   8. Maintain Asset
   9. Back to Main Menu
   Select an option:
   ```

3. **Select the desired option by typing the corresponding number.**

---

## Exiting the Program

To exit the application:

- **Type `10` or `exit` at the main menu prompt.**

**Prompt:**

```
Goodbye!
```

---

## Troubleshooting

- **Data Folder Missing:**

  If you move or delete the data folder, the program will prompt you to specify the new location.

  **Prompt:**

  ```
  Data folder not found or inaccessible.
  Please specify the data folder path:
  ```

- **Invalid Commands:**

  If you enter an invalid command, the program will notify you.

  **Prompt:**

  ```
  Invalid option.
  ```

- **File Not Found Errors:**

  Ensure that all required files are present in the data folder. The program will attempt to create missing files automatically.

---

## FAQs

**Q:** *I forgot my admin password. How can I reset it?*

**A:** If you have access to the `Users.csv` file, you can manually reset the password by editing the file or deleting it to allow the program to recreate it with the default admin user.

**Q:** *Can I import existing inventory data into the program?*

**A:** Yes, you can populate the `Inventory.csv` file with your existing data, ensuring it follows the correct format.

**Q:** *How do I backup my data?*

**A:** Regularly copy the data folder to a secure location to back up your data.

---

## Contact Support

If you encounter issues not addressed in this guide, please contact support at:

- **Email:** support@avecinventory.com
- **Phone:** +1 (555) 123-4567

---

**Thank you for using the Avec Inventory Tracker!**