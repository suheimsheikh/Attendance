#====================================================================================================
# START - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================

# THIS SECTION CONTAINS CRITICAL TESTING INSTRUCTIONS FOR BOTH AGENTS
# BOTH MAIN_AGENT AND TESTING_AGENT MUST PRESERVE THIS ENTIRE BLOCK

# Communication Protocol:
# If the `testing_agent` is available, main agent should delegate all testing tasks to it.
#
# You have access to a file called `test_result.md`. This file contains the complete testing state
# and history, and is the primary means of communication between main and the testing agent.
#
# Main and testing agents must follow this exact format to maintain testing data. 
# The testing data must be entered in yaml format Below is the data structure:
# 
## user_problem_statement: {problem_statement}
## backend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.py"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## frontend:
##   - task: "Task name"
##     implemented: true
##     working: true  # or false or "NA"
##     file: "file_path.js"
##     stuck_count: 0
##     priority: "high"  # or "medium" or "low"
##     needs_retesting: false
##     status_history:
##         -working: true  # or false or "NA"
##         -agent: "main"  # or "testing" or "user"
##         -comment: "Detailed comment about status"
##
## metadata:
##   created_by: "main_agent"
##   version: "1.0"
##   test_sequence: 0
##   run_ui: false
##
## test_plan:
##   current_focus:
##     - "Task name 1"
##     - "Task name 2"
##   stuck_tasks:
##     - "Task name with persistent issues"
##   test_all: false
##   test_priority: "high_first"  # or "sequential" or "stuck_first"
##
## agent_communication:
##     -agent: "main"  # or "testing" or "user"
##     -message: "Communication message between agents"

# Protocol Guidelines for Main agent
#
# 1. Update Test Result File Before Testing:
#    - Main agent must always update the `test_result.md` file before calling the testing agent
#    - Add implementation details to the status_history
#    - Set `needs_retesting` to true for tasks that need testing
#    - Update the `test_plan` section to guide testing priorities
#    - Add a message to `agent_communication` explaining what you've done
#
# 2. Incorporate User Feedback:
#    - When a user provides feedback that something is or isn't working, add this information to the relevant task's status_history
#    - Update the working status based on user feedback
#    - If a user reports an issue with a task that was marked as working, increment the stuck_count
#    - Whenever user reports issue in the app, if we have testing agent and task_result.md file so find the appropriate task for that and append in status_history of that task to contain the user concern and problem as well 
#
# 3. Track Stuck Tasks:
#    - Monitor which tasks have high stuck_count values or where you are fixing same issue again and again, analyze that when you read task_result.md
#    - For persistent issues, use websearch tool to find solutions
#    - Pay special attention to tasks in the stuck_tasks list
#    - When you fix an issue with a stuck task, don't reset the stuck_count until the testing agent confirms it's working
#
# 4. Provide Context to Testing Agent:
#    - When calling the testing agent, provide clear instructions about:
#      - Which tasks need testing (reference the test_plan)
#      - Any authentication details or configuration needed
#      - Specific test scenarios to focus on
#      - Any known issues or edge cases to verify
#
# 5. Call the testing agent with specific instructions referring to test_result.md
#
# IMPORTANT: Main agent must ALWAYS update test_result.md BEFORE calling the testing agent, as it relies on this file to understand what to test next.

#====================================================================================================
# END - Testing Protocol - DO NOT EDIT OR REMOVE THIS SECTION
#====================================================================================================



#====================================================================================================
# Testing Data - Main Agent and testing sub agent both should log testing data below this section
#====================================================================================================
## Session: Code review + fixes + perf (19 Jun 2026 fork)
user_problem_statement: "Do a code review and fix and also see if we can speed up the app" + prioritize the auto-save queue-interrupt bug in Daily Entry.
backend:
  - task: "Mongo indexes for meal_* collections (perf)"
    implemented: true
    working: true
    file: "backend/server.py"
    comment: "date + lines.item_id + lines.vendor_id indexes verified via index_information()"
  - task: "daily-totals issue valuation now reuses _stock_snapshot avg_rate (consistency + removed unbounded find({}))"
    implemented: true
    working: true
    file: "backend/routes/meals.py"
    comment: "curl verified: days rollup + grand totals return"
  - task: "muster/daily-roster blocked for escort tokens"
    implemented: true
    working: "needs_retest"
    file: "backend/routes/muster.py"
frontend:
  - task: "Daily Entry auto-save serialized promise chain (no overlapping/out-of-order PUTs)"
    implemented: true
    working: "needs_retest"
    file: "frontend/src/pages/admin/MealEntryTab.jsx"
    comment: "flushPurchases/flushIssues snapshot payload at call time, chain behind in-flight save, coalesce same-date snapshots"
  - task: "CheckinApprovals duplicate title prop removed"
    implemented: true
    working: "needs_retest"
    file: "frontend/src/pages/admin/CheckinApprovals.jsx"
agent_communication:
  - agent: "main"
    message: "Preview DB holds REAL production data. Test Daily Entry saves on PAST dates (e.g. 2026-08-01..02) and zero-out any values entered. 9 pre-existing pytest failures are stale seeded-data assertions (prod restore), unrelated."

## Session: Live pantry updates via SSE (19 Jun 2026 fork)
user_problem_statement: "Purchases entered in Daily Entry take >10 min to update on other machines (preview + production)". Root cause: no refresh mechanism — tabs fetched only on mount/date change. User chose pushed update signals over polling.
backend:
  - task: "SSE /api/meals/events + Mongo-backed meals_signal seq bump on all pantry mutations (purchases/issues/wastage/items/vendors/categories)"
    implemented: true
    working: true
    file: "backend/routes/meals.py, backend/services/client_ctx.py, backend/server.py"
    comment: "curl-verified externally: PUT from machine-B pushed frame seq=3 within 2s; 2KB padding + Content-Encoding identity defeat ingress/gzip buffering; 401 on bad token"
frontend:
  - task: "useMealsEvents hook (EventSource + baseline + echo suppression via X-Client-Id) wired into MealsReport parent; live refresh in MealEntryTab (guarded vs typing/pending saves), MealMastersTab, MealWastageTab, MealExpensesTab, MealCrossCheckTab, MealVendorsTab"
    implemented: true
    working: "needs_retest"
    file: "frontend/src/hooks/useMealsEvents.js, frontend/src/api.js, pages/admin/Meal*.jsx"
agent_communication:
  - agent: "main"
    message: "Preview DB holds REAL production data. Test with PAST dates (2026-08-01/02) and zero-out test values. Two-browser-context test needed: machine A saves purchase, machine B (on same date, Daily entry tab) should show it within ~5s without reload."
