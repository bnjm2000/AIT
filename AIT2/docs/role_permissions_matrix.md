# Showbase Role Permissions Matrix

Last verified against the application permission rules: August 28, 2026

Use this guide when assigning access or explaining what each account type can do.

## Access Model

Showbase uses three company roles. **Sales** is an optional permission added to an internal role; it is not a separate role. **Worker** access is a separate portal for freelancers, vendor personnel, and crew.

| Access level | Plain-language description |
| --- | --- |
| **Admin** | Company administrator. Has full operational control within the assigned company and can manage company users and roles. |
| **Manager** | Company operations manager. Has the same operational workspaces as an Admin, but cannot manage Admins or view system logs. |
| **User** | Operational user. Works only with events assigned to them and cannot use administrative workspaces or destructive management tools. |
| **Sales add-on** | Adds quotations, invoices, costing, and profit-and-loss tools to any internal role. It does not change the person's base role or event scope. |
| **Worker portal** | External-facing portal limited to the worker's own assignments, invoices, claims, payment status, and profile. |

## Internal Role Matrix

**Key:** Full = allowed; Assigned = allowed only for events assigned to that user; Limited = narrower controls described in the notes; Sales = requires the Sales add-on; No = not allowed.

| Capability | Admin | Manager | User | Notes |
| --- | :---: | :---: | :---: | --- |
| View company events | Full | Full | Assigned | Admin/Manager can access all events in the active company. |
| Create, edit, delete, or force-close events | Full | Full | No | These are administrative operations. |
| Event planning and comparison | Full | Full | No | Includes the Plan and Compare workspaces. |
| Prepare, return, and transfer assets | Full | Full | Assigned | Users can perform these workflows only for events they can access. |
| Event overview, delivery orders, and packing lists | Full | Full | Assigned | Event access rules apply to direct links and exports. |
| View and search inventory | Full | Full | Full | All internal roles can use the inventory view. |
| Add, edit, bulk-manage, or delete inventory assets | Full | Full | No | Includes destructive asset and container-management actions. |
| Containers, maintenance, and asset checks | Full | Full | Limited | Users can perform permitted operational actions. They may only modify their own eligible recent maintenance records; admin-only controls remain hidden. |
| Vehicles | Full | Full | No | Vehicle management is an administrative workspace. |
| Manpower, vendors, and workforce schedules | Full | Full | No | Includes assigning workers/vendors, roles, dates, and rates. |
| Transport planning and bookings | Full | Full | No | Administrative workspace. |
| Review invoices and claims inside an individual event | Full | Full | No | Includes approval, denial, payment status, upload slots, and event ZIP downloads. |
| View all invoices and claims across the company | Full | No | No | The company-wide queue is restricted to Admins. Managers review submissions from the selected event instead. |
| Submit personal internal claims in **My Claims** | No | No | Full | This workspace is intentionally limited to the standard User role. |
| Maintenance report | Full | Full | No | Administrative report. |
| System and event logs | Full | No | No | Logs are restricted to Admins because they can manage access levels. |
| Company PDF settings and departments | Full | Full | No | Applies to the active company. |
| View the user-management workspace | Full | Full | No | What each role may change is shown in the next table. |
| Quotations, invoices, and costing | Sales | Sales | Sales | Requires the Sales add-on. |
| Profit and loss | Sales | Sales | Sales | Requires the Sales add-on. |

## User Administration Matrix

User administration is limited to the actor's assigned company.

| Administration action | Admin | Manager | User |
| --- | :---: | :---: | :---: |
| View users | Own company | Own company | No |
| Create users | Full | Full | No |
| Edit profile, username, active status, or reset password | Admin, Manager, or User | Manager or User | No |
| Assign **Admin** role | Full | No | No |
| Assign **Manager** or **User** role | Full | Full | No |
| Grant or remove Sales access | For manageable users | For manageable users | No |
| Delete another user | Admin, Manager, or User | Manager or User | No |

Safeguards still apply: a person cannot delete their own account, and a company must retain at least one active Admin.

## Sales Add-on Examples

| Example account | Resulting access |
| --- | --- |
| **User** without Sales | Assigned operational events, inventory, asset workflows, maintenance/asset checks, and My Claims. |
| **User + Sales** | Everything a User can do, plus quotations, invoices, costing, and profit and loss. Event access remains assignment-based. |
| **Manager + Sales** | All Manager operational/admin workspaces, plus the Sales tools. Still cannot view system logs or manage Admins. |
| **Admin + Sales** | Full company administration, system logs, and Sales tools. |

## Worker Portal Matrix

Worker accounts do not use the internal role hierarchy.

| Worker capability | Access |
| --- | :---: |
| View their assigned current and past events | Full |
| View event, date, location, department, and role details | Full |
| Upload invoices and claims into available slots | Full |
| Replace or remove an editable/denied submission | Limited |
| Track review, approval, denial, and payment status | Full |
| Confirm that payment was received | Full |
| Update their phone number or PIN/password | Full |
| View other workers, inventory, planning, users, or company settings | No |

## Assignment Guidance

| If the person needs to... | Recommended access |
| --- | --- |
| Run day-to-day operations without controlling Admin accounts or audit logs | **Manager** |
| Administer a company's operations, users, roles, and audit logs | **Admin** |
| Work only on specifically assigned events and submit personal claims | **User** |
| Prepare quotes, invoices, costing, or profit-and-loss documents | Add **Sales** to the appropriate internal role |
| Submit freelance/vendor invoices or claims only | **Worker portal** |
