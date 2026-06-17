"""
Panini World Cup 2026 checklist importer.

Takes raw checklist text (the common community format, e.g. copy-pasted
from a forum, eBay listing, or fan checklist site) and converts it into
SQL INSERT statements for the `stickers` table.

Expected line formats it understands:
    MEX1 Team Logo - Mexico FOIL
    MEX2 Luis Malagón - Mexico
    FWC6 Canada - Host Countries & Cities FOIL
    00 Panini Logo FOIL

General pattern: <code> <description> [- <team>] [FOIL]

Usage:
    python3 import_checklist.py raw_checklist.txt > seed_real.sql

Then run the resulting seed_real.sql against the database (it replaces
the placeholder rows from seed_stickers.sql for album_id = 1).
"""

import re
import sys

CODE_PATTERN = re.compile(r'^([A-Z]{2,4}\d{1,2}|\d{1,2})\s+(.*)$')

def parse_line(line):
    line = line.strip()
    if not line:
        return None

    match = CODE_PATTERN.match(line)
    if not match:
        return None

    code, rest = match.groups()

    is_foil = False
    if rest.upper().endswith('FOIL'):
        is_foil = True
        rest = rest[:-4].strip()

    team = None
    description = rest
    if ' - ' in rest:
        parts = rest.rsplit(' - ', 1)
        description, team = parts[0].strip(), parts[1].strip()

    return {
        'code': code,
        'description': description,
        'team': team,
        'is_foil': is_foil,
    }


def generate_sql(stickers, album_id=1):
    lines = []
    lines.append("-- Generated from real checklist import")
    lines.append(f"DELETE FROM stickers WHERE album_id = {album_id};")
    lines.append("")
    lines.append("INSERT INTO stickers (album_id, sticker_number, team_name, description, is_shiny) VALUES")

    values = []
    for s in stickers:
        desc = s['description'].replace("'", "''")
        team = f"'{s['team'].replace(chr(39), chr(39)*2)}'" if s['team'] else 'NULL'
        values.append(
            f"({album_id}, '{s['code']}', {team}, '{desc}', {str(s['is_foil']).upper()})"
        )

    lines.append(",\n".join(values) + ";")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        print("Usage: python3 import_checklist.py <checklist.txt>", file=sys.stderr)
        sys.exit(1)

    with open(sys.argv[1], 'r', encoding='utf-8') as f:
        raw = f.read()

    stickers = []
    skipped = []
    for line in raw.splitlines():
        parsed = parse_line(line)
        if parsed:
            stickers.append(parsed)
        elif line.strip():
            skipped.append(line.strip())

    print(generate_sql(stickers))

    print(f"\n-- Parsed: {len(stickers)} stickers", file=sys.stderr)
    print(f"-- Skipped/unrecognized lines: {len(skipped)}", file=sys.stderr)
    if skipped:
        print("-- First few skipped lines (check formatting):", file=sys.stderr)
        for s in skipped[:5]:
            print(f"--   {s}", file=sys.stderr)


if __name__ == '__main__':
    main()
