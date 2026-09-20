"""Client record rules shared by the directory and saved finance documents."""

from models import Client


def normalise_salutation(value):
    salutation = str(value or '').strip()
    return salutation if salutation in {'Mr.', 'Ms.', 'Mrs.', 'Mdm.'} else ''


def normalise_client(value):
    value = value if isinstance(value, dict) else {}
    return {
        'salutation': normalise_salutation(value.get('salutation')),
        'name': str(value.get('name') or '').strip()[:160],
        'company': str(value.get('company') or '').strip()[:200],
        'contactPerson': str(value.get('contactPerson') or '').strip()[:160],
        'email': str(value.get('email') or '').strip()[:200],
        'phone': str(value.get('phone') or '').strip()[:80],
        'taxNumber': str(value.get('taxNumber') or '').strip()[:100],
        'address1': str(value.get('address1') or '').strip()[:240],
        'address2': str(value.get('address2') or '').strip()[:240],
        'address3': str(value.get('address3') or '').strip()[:240],
        'postalCode': str(value.get('postalCode') or '').strip()[:40],
    }


def client_key(manager, name):
    target = str(name or '').strip().casefold()
    if not target:
        return ''
    return next(
        (
            str(key)
            for key in manager.clients
            if str(key or '').strip().casefold() == target
        ),
        '',
    )


def client_is_active(client):
    return bool(client and getattr(client, 'is_active', True))


def client_from_payload(payload, *, is_active=True):
    client = normalise_client(payload)
    return Client(
        name=client['name'],
        salutation=client['salutation'],
        company=client['company'],
        contact_person=client['contactPerson'],
        email=client['email'],
        phone=client['phone'],
        tax_number=client['taxNumber'],
        address1=client['address1'],
        address2=client['address2'],
        address3=client['address3'],
        postal_code=client['postalCode'],
        is_active=is_active,
    )


def client_to_dict(c):
    def get(attribute, default=''):
        snake_case_attribute = attribute.replace('postalCode', 'postal_code')
        return getattr(c, attribute, getattr(c, snake_case_attribute, default))

    return {
        'salutation': normalise_salutation(getattr(c, 'salutation', '')),
        'name': get('name'),
        'company': get('company'),
        'contactPerson': getattr(c, 'contact_person', ''),
        'email': getattr(c, 'email', ''),
        'taxNumber': getattr(c, 'tax_number', ''),
        'address1': get('address1'),
        'address2': get('address2'),
        'address3': get('address3'),
        'postalCode': getattr(c, 'postal_code', getattr(c, 'postalCode', '')),
        'phone': get('phone'),
    }
