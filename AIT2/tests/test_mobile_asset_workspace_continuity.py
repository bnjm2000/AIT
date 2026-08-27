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

    def test_operational_workspaces_share_mobile_width_and_safe_area_rules(self):
        template = (
            Path(__file__).resolve().parents[1] / 'templates' / 'index.html'
        ).read_text(encoding='utf-8')
        self.assertIn('Mobile workflow hardening for Plan, Manpower, Transport, Prepare and Return.', template)
        for selector in (
            '#plan-section',
            '#workforce-section',
            '#transport-section',
            '#prepare-new-section',
            '#return-section',
        ):
            self.assertIn(selector, template)
        self.assertIn('overflow-x: clip;', template)
        self.assertIn('padding-bottom: max(10px, env(safe-area-inset-bottom));', template)
        self.assertIn('bottom: env(safe-area-inset-bottom);', template)

    def test_mobile_workflow_controls_have_touch_sized_targets(self):
        template = (
            Path(__file__).resolve().parents[1] / 'templates' / 'index.html'
        ).read_text(encoding='utf-8')
        schedule_css = (
            Path(__file__).resolve().parents[1]
            / 'static'
            / 'css'
            / 'workforce-schedule.css'
        ).read_text(encoding='utf-8')
        self.assertIn(':is(.plan-search-input, .return-search-input)', template)
        self.assertIn('.plan-event-chooser-search input,', template)
        self.assertIn('.plan-event-chooser-page {', template)
        self.assertIn(':is(.plan-chip, .return-chip)', template)
        self.assertIn('#plan-section.active .plan-result-row .plan-inline-actions .plan-search-input,', template)
        self.assertIn('#plan-section.active .plan-availability-count {', template)
        self.assertIn('#plan-section.active .plan-qty-control :is(button, input) {', template)
        self.assertIn(':is(#plan-section, #prepare-new-section).active .plan-custom-type-toggle button,', template)
        self.assertIn(':is(#plan-section, #prepare-new-section, #return-section).active .event-detail-icon-button {', template)
        self.assertIn('.prepare-new-heading-actions .plan-button,', template)
        self.assertIn('.return-quick-row {', template)
        self.assertIn('grid-template-columns: minmax(0, 1fr) 44px;', template)
        self.assertIn('.wf-view-switch {', template)
        self.assertIn('.wf-schedule-filter-options > button,', template)
        self.assertIn('.wf-modal-card button {', template)
        self.assertIn('.wf-modal-card :is(.wf-book-mode-toggle button, .wf-link-button) {', template)
        self.assertIn('min-height: 44px;', template)
        self.assertIn('.wf-schedule-actions .wf-button {', schedule_css)
        self.assertIn('.wf-schedule-person-download,', schedule_css)
        self.assertIn('.wf-schedule-person-meta {', schedule_css)
        self.assertIn('.wf-coverage-toggle button {', schedule_css)
        self.assertIn('.wf-schedule-controls input[type="time"],', schedule_css)

    def test_narrow_transport_routes_stack_instead_of_squeezing_locations(self):
        template = (
            Path(__file__).resolve().parents[1] / 'templates' / 'index.html'
        ).read_text(encoding='utf-8')
        self.assertIn('.wf-trip-card .wf-route > strong {', template)
        self.assertIn('.wf-route-arrow {', template)
        self.assertIn('transform: rotate(90deg);', template)


if __name__ == '__main__':
    unittest.main()
