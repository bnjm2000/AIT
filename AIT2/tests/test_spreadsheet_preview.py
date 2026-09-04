import io
from pathlib import Path
from types import SimpleNamespace
import tempfile
import unittest
from unittest.mock import patch
import zipfile

from spreadsheet_preview import display_value, read_spreadsheet_preview, read_xls


def invoice_xlsx_bytes():
    """Small real OOXML fixture, including saved and unsaved formula results."""
    output = io.BytesIO()
    with zipfile.ZipFile(output, 'w') as archive:
        archive.writestr('[Content_Types].xml', '''<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
          <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
          <Default Extension="xml" ContentType="application/xml"/>
          <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
          <Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>
          <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
        </Types>''')
        archive.writestr('_rels/.rels', '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
        </Relationships>''')
        archive.writestr('xl/workbook.xml', '''<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
          <sheets><sheet name="Invoice &amp; charges" sheetId="1" r:id="rId1"/></sheets>
        </workbook>''')
        archive.writestr('xl/_rels/workbook.xml.rels', '''<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
          <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>
          <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
        </Relationships>''')
        archive.writestr('xl/styles.xml', '''<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <numFmts count="1"><numFmt numFmtId="164" formatCode="&quot;$&quot;#,##0.00"/></numFmts>
          <fonts count="1"><font><sz val="11"/><name val="Calibri"/></font></fonts>
          <fills count="1"><fill><patternFill patternType="none"/></fill></fills>
          <borders count="1"><border/></borders>
          <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
          <cellXfs count="3"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="14" fontId="0" fillId="0" borderId="0" xfId="0"/></cellXfs>
          <cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>
        </styleSheet>''')
        archive.writestr('xl/worksheets/sheet1.xml', '''<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
          <dimension ref="A1:C250"/><sheetData>
          <row r="1"><c r="A1" t="inlineStr"><is><t>&lt;script&gt;alert(1)&lt;/script&gt;</t></is></c></row>
          <row r="2"><c r="A2" t="inlineStr"><is><t>Total</t></is></c><c r="B2" s="1"><f>1000+200.50</f><v>1200.50</v></c><c r="C2" s="2"><v>45000</v></c></row>
          <row r="3"><c r="B3"><f>SUM(B2)</f></c></row>
          <row r="250"><c r="A250" t="inlineStr"><is><t>Outside preview limit</t></is></c></row>
          </sheetData></worksheet>''')
    return output.getvalue()


class SpreadsheetPreviewTests(unittest.TestCase):
    def test_xlsx_values_saved_formulas_missing_results_dates_and_limits(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'invoice.xlsx'
            path.write_bytes(invoice_xlsx_bytes())
            result = read_spreadsheet_preview(path)
        sheet = result['sheets'][0]
        self.assertEqual(sheet['name'], 'Invoice & charges')
        self.assertEqual(sheet['rows'][1][1]['text'], '$1,200.50')
        self.assertEqual(sheet['rows'][1][2]['text'], '15 Mar 2023')
        self.assertEqual(sheet['rows'][2][1]['text'], 'Not calculated')
        self.assertTrue(sheet['rows'][2][1]['missing'])
        self.assertTrue(sheet['truncated'])
        self.assertEqual(len(sheet['rows']), 3)

    def test_legacy_xls_reader_uses_cached_values_and_releases_resources(self):
        import xlrd
        from unittest.mock import Mock

        sheet = SimpleNamespace(name='Invoice', visibility=0, nrows=1, ncols=1,
                                cell=lambda r, c: SimpleNamespace(value=1500.5, ctype=xlrd.XL_CELL_NUMBER, xf_index=0))
        book = SimpleNamespace(nsheets=1, sheet_by_index=lambda i: sheet,
                               xf_list=[SimpleNamespace(format_key=164, font_index=0)],
                               format_map={164: SimpleNamespace(format_str='$#,##0.00')},
                               font_list=[SimpleNamespace(bold=True)],
                               unload_sheet=Mock(), release_resources=Mock())
        with patch('xlrd.open_workbook', return_value=book):
            result = read_xls('legacy.xls')
        self.assertEqual(result['sheets'][0]['rows'][0][0]['text'], '$1,500.50')
        book.release_resources.assert_called_once()

    def test_invalid_and_oversized_archives_fail_safely(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'bad.xlsx'
            path.write_bytes(b'not a workbook')
            with self.assertRaisesRegex(ValueError, 'could not be previewed'):
                read_spreadsheet_preview(path)
            path.write_bytes(invoice_xlsx_bytes())
            with patch('spreadsheet_preview.MAX_EXPANDED_BYTES', 10):
                with self.assertRaisesRegex(ValueError, 'too large'):
                    read_spreadsheet_preview(path)

    def test_identifiers_and_numeric_values_are_not_silently_truncated(self):
        self.assertEqual(display_value(123, '000000'), '000123')
        self.assertEqual(display_value(123456789, 'General'), '123456789')
        self.assertEqual(display_value(123456789, '#,##0'), '123,456,789')
        self.assertEqual(display_value(1234.5, '#,##0.##'), '1,234.5')
        self.assertEqual(display_value(0.09, '0.00%'), '9.00%')

    def test_xml_entities_are_rejected_before_workbook_parsing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'unsafe.xlsx'
            path.write_bytes(invoice_xlsx_bytes())
            with zipfile.ZipFile(path, 'a') as archive:
                archive.writestr('unsafe.xml', '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]><x/>')
            with self.assertRaisesRegex(ValueError, 'cannot be safely previewed'):
                read_spreadsheet_preview(path)

    def test_xml_entities_are_rejected_before_workbook_parsing(self):
        with tempfile.TemporaryDirectory() as folder:
            path = Path(folder) / 'unsafe.xlsx'
            path.write_bytes(invoice_xlsx_bytes())
            with zipfile.ZipFile(path, 'a') as archive:
                archive.writestr('unsafe.xml', '<!DOCTYPE x [<!ENTITY y SYSTEM "file:///secret">]><x/>')
            with self.assertRaisesRegex(ValueError, 'cannot be safely previewed'):
                read_spreadsheet_preview(path)


if __name__ == '__main__':
    unittest.main()
