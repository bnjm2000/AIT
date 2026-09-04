"""Explicit, offline calibration of document amount detection from reviewed uploads.

No automatic training occurs during uploads. Models contain hashed layout cues and
score adjustments, never receipt text, payee names, or historical payable amounts.
"""
from __future__ import annotations

import argparse
from collections import Counter, defaultdict
import hashlib
import json
import os
from pathlib import Path
import tempfile


MODEL_FILENAME = 'DocumentDetectionLearning.json'
CACHE_FILENAME = 'DocumentDetectionTrainingCache.json'
VERSION = 1


def load_amount_profile(data_folder, kind):
    if not data_folder:
        return {}
    try:
        model = json.loads((Path(data_folder) / MODEL_FILENAME).read_text(encoding='utf-8'))
        if model.get('version') != VERSION or not model.get('enabled'):
            return {}
        rules = model.get('profiles', {}).get(kind, {})
        return {
            key: max(-100, min(140, int(value)))
            for key, value in rules.items()
            if len(key) == 64 and isinstance(value, (int, float))
        }
    except (OSError, ValueError, TypeError, AttributeError, OverflowError):
        return {}


def submission_records(workforce):
    for people in workforce.get('submissions', {}).values():
        if not isinstance(people, dict):
            continue
        for documents in people.values():
            if not isinstance(documents, dict):
                continue
            for key, kind in (('invoices', 'invoice'), ('claims', 'claim')):
                for record in documents.get(key, []) or []:
                    if isinstance(record, dict):
                        yield kind, record
    for bookings in workforce.get('transportBookings', {}).values():
        for booking in bookings or []:
            record = booking.get('invoice') if isinstance(booking, dict) else None
            if isinstance(record, dict):
                yield 'invoice', record


def trusted_record(record):
    from workforce import money

    return (
        record.get('status') in {'Approved', 'Paid', 'Payment Confirmed'}
        and bool(record.get('verifiedAt') or record.get('reviewedAt'))
        and (money(record.get('amount'), 0) or 0) > 0
    )


def training_candidates(path, kind):
    """Use exactly the same native-text/OCR routing as uncalibrated extraction."""
    from workforce import (
        _amount_candidates, _amount_from_text, _date_from_text,
        _ocr_image, _ocr_pdf, _pdf_text,
    )

    if Path(path).suffix.lower() == '.pdf':
        text = _pdf_text(path)
        baseline = _amount_from_text(text)
        use_native = baseline['amount'] is not None and baseline['confidence'] != 'Low'
        if kind == 'claim':
            use_native = use_native and bool(_date_from_text(text)['date'])
        if not use_native:
            ocr_text = _ocr_pdf(path)
            if _amount_from_text(ocr_text)['amount'] is not None:
                text = ocr_text
    else:
        text = _ocr_image(path)
    return [
        {key: row[key] for key in ('score', 'lineIndex', 'amount', 'feature')}
        for row in _amount_candidates(text)
    ]


def document_votes(sample):
    # One vote per document, not per repeated line or duplicate upload.
    positive, negative = set(), set()
    for row in sample['candidates']:
        target = positive if row['amount'] == sample['expected'] else negative
        target.add(row['feature'])
    return positive, negative


def build_profiles(samples):
    totals = defaultdict(lambda: (Counter(), Counter()))
    for sample in samples:
        positive, negative = document_votes(sample)
        totals[sample['kind']][0].update(positive)
        totals[sample['kind']][1].update(negative)
    return totals


def rules_from_votes(positive, negative):
    rules = {}
    for feature, count in positive.items():
        if count >= 2 and negative[feature] == 0:
            rules[feature] = 140
    for feature, count in negative.items():
        if count >= 2 and positive[feature] == 0:
            rules[feature] = -100
    return rules


def predicted_amount(candidates, rules=None):
    if not candidates:
        return None
    rules = rules or {}
    return max(candidates, key=lambda row: (
        row['score'] + rules.get(row['feature'], 0), row['lineIndex'], row['amount'],
    ))['amount']


def calibrate(samples):
    totals = build_profiles(samples)
    profiles = {kind: rules_from_votes(*votes) for kind, votes in totals.items()}
    evaluation = {'documents': len(samples), 'baselineCorrect': 0,
                  'learnedCorrect': 0, 'improved': 0, 'regressed': 0}
    # Leave each document (including all of its cues) out of its own evaluation.
    for sample in samples:
        positive, negative = totals[sample['kind']]
        own_positive, own_negative = document_votes(sample)
        rules = rules_from_votes(
            positive - Counter(own_positive), negative - Counter(own_negative),
        )
        baseline_ok = predicted_amount(sample['candidates']) == sample['expected']
        learned_ok = predicted_amount(sample['candidates'], rules) == sample['expected']
        evaluation['baselineCorrect'] += int(baseline_ok)
        evaluation['learnedCorrect'] += int(learned_ok)
        evaluation['improved'] += int(learned_ok and not baseline_ok)
        evaluation['regressed'] += int(baseline_ok and not learned_ok)
    # Fail closed if independently evaluated documents became less accurate.
    enabled = bool(samples and any(profiles.values()) and evaluation['regressed'] == 0)
    return profiles, evaluation, enabled


def atomic_json(path, value):
    path = Path(path)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = None
    try:
        with tempfile.NamedTemporaryFile(mode='w', encoding='utf-8', dir=path.parent,
                                         suffix='.tmp', delete=False) as handle:
            temporary = handle.name
            json.dump(value, handle, indent=2, sort_keys=True)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, path)
    finally:
        if temporary and os.path.exists(temporary):
            os.unlink(temporary)


def database_snapshot(company_code):
    """Read an authoritative snapshot without migrations, writes or app startup."""
    import psycopg
    from dotenv import load_dotenv

    load_dotenv(Path(__file__).with_name('.env'))
    dsn = os.environ.get('DATABASE_URL', '').strip()
    if not dsn:
        raise ValueError('DATABASE_URL is not configured')
    with psycopg.connect(dsn, connect_timeout=10,
                         options='-c default_transaction_read_only=on') as connection:
        row = connection.execute(
            'SELECT data FROM aim_company_documents WHERE company_code = %s AND document_key = %s',
            (company_code, 'workforce'),
        ).fetchone()
    if not row:
        raise ValueError(f'No workforce document found for {company_code}')
    return row[0]


def train_snapshot(data_folder, *, apply=False, inventory_only=False, workforce_snapshot=None):
    from workforce import load_workforce, money, now_iso, upload_absolute_path

    folder = Path(data_folder).resolve()
    if workforce_snapshot is None and not (folder / 'Workforce.json').is_file():
        raise ValueError(f'No Workforce.json snapshot in {folder}')
    workforce = workforce_snapshot if workforce_snapshot is not None else load_workforce(str(folder))
    records = list(submission_records(workforce))
    report = {'dataFolder': str(folder), 'records': len(records),
              'reviewedRecords': sum(trusted_record(row) for _, row in records)}
    if inventory_only:
        return report
    cache_path = folder / CACHE_FILENAME
    try:
        cache = json.loads(cache_path.read_text(encoding='utf-8'))
        if cache.get('version') != VERSION:
            cache = {}
    except (OSError, ValueError):
        cache = {}
    cached_documents = cache.setdefault('documents', {})
    exclusions = Counter()
    samples_by_digest = {}
    conflicted = set()
    snapshot = hashlib.sha256()
    for index, (kind, record) in enumerate(records):
        snapshot.update(json.dumps(record, sort_keys=True).encode())
        if not trusted_record(record):
            exclusions['unreviewedOrDenied'] += 1
            continue
        path = upload_absolute_path(str(folder), record.get('storedPath'))
        if not path or not Path(path).is_file():
            exclusions['missingFile'] += 1
            continue
        if Path(path).suffix.lower() not in {'.pdf', '.png', '.jpg', '.jpeg'}:
            exclusions['unsupportedFormat'] += 1
            continue
        digest = hashlib.sha256(Path(path).read_bytes()).hexdigest()
        key = kind + ':' + digest
        expected = money(record.get('amount'))
        if key in samples_by_digest:
            if samples_by_digest[key]['expected'] != expected:
                conflicted.add(key)
            exclusions['duplicateDocument'] += 1
            continue
        candidates = cached_documents.get(key)
        if candidates is None:
            candidates = training_candidates(path, kind)
            cached_documents[key] = candidates
            if apply:
                atomic_json(cache_path, {'version': VERSION, 'documents': cached_documents})
        samples_by_digest[key] = {
            'kind': kind, 'expected': expected, 'candidates': candidates,
        }
        if index % 10 == 0:
            print(json.dumps({'companyFolder': str(folder), 'processedRecords': index + 1,
                              'totalRecords': len(records)}), flush=True)
    samples = []
    baseline_audit = {'reviewedUniqueDocuments': len(samples_by_digest),
                      'baselineCorrect': 0, 'noReadableAmount': 0}
    for key, sample in samples_by_digest.items():
        baseline_audit['baselineCorrect'] += int(
            predicted_amount(sample['candidates']) == sample['expected']
        )
        if key in conflicted:
            exclusions['conflictingReviewedAmounts'] += 1
        elif not sample['candidates']:
            exclusions['noReadableAmount'] += 1
            baseline_audit['noReadableAmount'] += 1
        elif sample['expected'] not in {row['amount'] for row in sample['candidates']}:
            exclusions['verifiedAmountNotInDocumentText'] += 1
        else:
            samples.append(sample)
    profiles, evaluation, enabled = calibrate(samples)
    report.update({'exclusions': dict(exclusions), 'baselineAudit': baseline_audit,
                   'evaluation': evaluation, 'enabled': enabled,
                   'rules': {kind: len(rules) for kind, rules in profiles.items()}})
    model = {'version': VERSION, 'trainedAt': now_iso(), 'enabled': enabled,
             'automaticTraining': False, 'snapshotDigest': snapshot.hexdigest(),
             'profiles': profiles, 'report': report}
    if apply:
        # Preserve an existing working model if the new snapshot fails evaluation.
        if enabled:
            atomic_json(folder / MODEL_FILENAME, model)
        atomic_json(folder / 'DocumentDetectionTrainingReport.json', report)
    return report


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--data-folder', required=True, action='append')
    parser.add_argument('--apply', action='store_true')
    parser.add_argument('--inventory-only', action='store_true')
    parser.add_argument('--from-database', action='store_true',
                        help='Read the configured database, not an older JSON export')
    args = parser.parse_args()
    for folder in args.data_folder:
        snapshot = database_snapshot(Path(folder).resolve().parent.name) if args.from_database else None
        print(json.dumps(train_snapshot(folder, apply=args.apply,
                                        inventory_only=args.inventory_only,
                                        workforce_snapshot=snapshot)), flush=True)


if __name__ == '__main__':
    main()
