#!/usr/bin/env python3
import json

report = {
  "verdict": "fixed",
  "user_reported_bug": "When we request a correction for leave on the grid by clicking on a cell then it should seek out the entire leave application and allow for its cancellation and then display LP. Same for Tour.",
  "summary": "No relevant testing skill found. Focused backend/API and UI verification passed for Grid leave/tour cancellation: LV/TR grid cells carry leave_id metadata, clicking an LV cell opens CorrectionRequestModal with no candidate picker, submit succeeds with 'Correction applied', and the full leave/tour date range changes to LP. Undo restores LV/TR, convert_to_lop=false does not paint LP, and non-leave-family cells did not expose leave_id.",
  "backend_issues": {"critical": [], "minor": []},
  "frontend_issues": {"ui_bugs": [], "integration_issues": [], "design_issues": []},
  "test_report_links": [
    "/app/test_reports/bug_verification_leave_cancel_grid_api.py",
    "/app/test_reports/bug_verification_leave_cancel_grid_api_results.json",
    "/app/test_reports/bug_verification_leave_cancel_grid_ui_seed.json"
  ],
  "action_items": [],
  "critical_code_review_comments": [],
  "updated_files": [
    "/app/test_reports/bug_verification_leave_cancel_grid_api.py",
    "/app/test_reports/bug_verification_leave_cancel_grid_api_results.json",
    "/app/test_reports/bug_verification_leave_cancel_grid_ui_seed.json",
    "/app/test_reports/bug_verification_29.json",
    "/app/test_reports/iteration_29.json"
  ],
  "success_rate": {"backend": "100%", "frontend": "100%"},
  "seed_data_creation": "Created isolated QA members and approved 3-day leave/tour rows in July 2026 via public API. Some rows were intentionally cancelled/undone for verification; one UI seed leave was cancelled from the browser and now displays LP across 2026-07-01 to 2026-07-03.",
  "retest_needed": False,
  "should_main_agent_self_test": False,
  "context_for_next_testing_agent": "Focused test only. API script seeds members with prefix qa.leavegrid.*, verifies LV/TR/LP behavior, undo, convert_to_lop=false, and metadata. UI test used seed member QA Leave Grid Ui 1784516112659 on /admin/reports?tab=calendar and verified no picker + LP conversion after submit.",
  "rca_of_the_issue": "The fix appears to address the original bug by exposing the underlying leave row id in calendar-grid cell_meta for leave-family cells, passing that id to the correction modal, and making leave_cancel default to converted_to_lop so the calendar-grid renders cancelled leave/tour ranges as LP instead of falling back to AB. Direct UI/API evidence confirmed the end-to-end outcome. No APIs were mocked."
}

for path in ["/app/test_reports/bug_verification_29.json", "/app/test_reports/iteration_29.json"]:
    with open(path, "w", encoding="utf-8") as f:
        json.dump(report, f, indent=2)
        f.write("\n")
print(json.dumps(report, indent=2))