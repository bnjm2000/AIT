import unittest
from pathlib import Path

from tests.static_source import APP_BUNDLE_SOURCE


class MobileAssetWorkspaceContinuityTests(unittest.TestCase):
    def test_plan_preserves_mobile_accordion_and_workspace_scroll(self):
        source = APP_BUNDLE_SOURCE
        self.assertIn('departmentOpenState: new Map()', source)
        self.assertIn('function planSetDepartmentOpen(', source)
        self.assertIn('data-plan-department=', source)
        self.assertIn('function planCaptureViewState()', source)
        self.assertIn("const contentArea = root.closest('.content-area');", source)
        self.assertIn('requestAnimationFrame(() => planRestoreViewState(viewState));', source)
        self.assertIn('planRestoreViewState(viewState);', source)

    def test_prepare_preserves_mobile_scroller_and_clears_only_completed_form(self):
        source = APP_BUNDLE_SOURCE
        self.assertIn('contentAreaTop: contentArea?.scrollTop || 0,', source)
        self.assertIn('contentArea.scrollTop = state.contentAreaTop || 0;', source)
        self.assertIn('if (viewState && options.resetCustomForm)', source)
        self.assertIn(
            'refreshPrepareNewSelectedEvent({ preserve: true, resetCustomForm: true })',
            source,
        )
        self.assertNotIn(
            'refreshPrepareNewSelectedEvent({ preserve: false });',
            source,
        )

    def test_return_and_transfer_keep_open_groups_and_scroll_position(self):
        source = APP_BUNDLE_SOURCE
        self.assertIn('customGroupOpenState: new Map()', source)
        self.assertIn('function returnPageSetDepartmentOpen(', source)
        self.assertIn('function returnPageSetCustomGroupOpen(', source)
        self.assertIn('data-return-department=', source)
        self.assertIn('data-return-custom-group=', source)
        self.assertIn('function captureTransferViewport()', source)
        self.assertIn('restoreTransferViewport(viewport);', source)

    def test_line_item_editors_preserve_the_shared_mobile_viewport(self):
        script_root = Path(__file__).resolve().parents[1] / 'static' / 'js'
        shared = (script_root / 'line-workspace.js').read_text(encoding='utf-8')
        costing = (script_root / 'costing.js').read_text(encoding='utf-8')
        finance = (script_root / 'finance.js').read_text(encoding='utf-8')
        self.assertIn('captureViewport(root)', shared)
        self.assertIn('restoreViewport(root, state)', shared)
        self.assertIn('showbaseLineWorkspace.restoreViewport(root, viewport);', costing)
        self.assertIn('showbaseLineWorkspace.restoreViewport(root, viewport);', finance)


if __name__ == '__main__':
    unittest.main()
