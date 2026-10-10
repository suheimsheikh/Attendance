// Quick-pick durations for the one-tap Step-out card. The "return-by"
// time is auto-computed as now + the selected minutes — saves the user
// fiddling with a time picker just to log a lunch break. Shared by the
// self and escort check-in screens.
export const STEP_OUT_DURATIONS = [
  { min: 30,  label: "30 min" },
  { min: 60,  label: "1 hour" },   // default
  { min: 120, label: "2 hours" },
];
