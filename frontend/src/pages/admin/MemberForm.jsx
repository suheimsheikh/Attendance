import React, { useEffect, useState } from "react";
import { X, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";
import { useEscape } from "../../hooks/useEscape";
import { fileToResizedDataUrl } from "../../utils";
import Avatar from "../../components/Avatar";
import FormErrorBanner from "../../components/FormErrorBanner";
import { useFormError } from "../../hooks/useFormError";

export default function MemberForm({ initial, onClose, onSaved }) {
  useEscape(onClose);
  const isEdit = !!initial;
  const [form, setForm] = useState({
    full_name: initial?.full_name || "",
    email: initial?.email || "",
    password: "",
    mobile: initial?.mobile || "",
    rank: initial?.rank || "",
    category: initial?.category || "athlete",
    role: initial?.role || "member",
    work_start: initial?.work_start || "",
    work_end: initial?.work_end || "",
    institution: initial?.institution || "",
    gender: initial?.gender || "",
    fleet: initial?.fleet || "",
    photo: initial?.photo || "",
    weekly_off: initial?.weekly_off || "monday",
    father_mobile: initial?.father_mobile || "",
    father_name: initial?.father_name || "",
    mother_mobile: initial?.mother_mobile || "",
    mother_name: initial?.mother_name || "",
    guardian_mobile: initial?.guardian_mobile || "",
    guardian_name: initial?.guardian_name || "",
    date_of_birth: initial?.date_of_birth || "",
    // Undefined on legacy members → treat as eligible (matches the
    // backend's opt-out semantics). Admin can uncheck to disable.
    ot_eligible: initial?.ot_eligible !== false,
  });
  const [busy, setBusy] = useState(false);
  const [photoBusy, setPhotoBusy] = useState(false);
  const [institutions, setInstitutions] = useState([]);
  const [fleets, setFleets] = useState([]);
  const formErr = useFormError();

  useEffect(() => {
    api.get("/institutions").then((rows) => setInstitutions((rows || []).filter((r) => r.active))).catch(() => {});
    api.get("/fleets").then((rows) => setFleets((rows || []).filter((r) => r.active))).catch(() => {});
  }, []);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onPickPhoto = async (file) => {
    if (!file) return;
    if (!/^image\//.test(file.type)) { toast.error("Please pick an image file"); return; }
    setPhotoBusy(true);
    try {
      const url = await fileToResizedDataUrl(file);
      set("photo", url);
    } catch {
      toast.error("Could not read image");
    } finally {
      setPhotoBusy(false);
    }
  };

  const submit = async (e) => {
    e.preventDefault();
    formErr.clear();
    if (!form.full_name.trim()) { formErr.setMessage("Name is required"); return; }
    if (!isEdit && !form.email.trim()) { formErr.setMessage("Email is required"); return; }
    if (!isEdit && (form.password || "").length < 4) { formErr.setMessage("Password must be ≥ 4 chars"); return; }
    setBusy(true);
    try {
      if (isEdit) {
        const body = { ...form };
        if (!body.password) delete body.password;
        delete body.email; // backend doesn't update email
        // Strip empty optional fields so Pydantic Literal validators (gender, role, etc.) don't 422.
        // We keep explicit nulls but drop "" since the backend treats absent == unchanged.
        Object.keys(body).forEach((k) => {
          if (body[k] === "") delete body[k];
        });
        await api.patch(`/members/${initial.id}`, body);
        toast.success("Member updated");
      } else {
        await api.post("/members", form);
        toast.success("Member created");
      }
      onSaved();
    } catch (err) {
      formErr.setFromApi(err, "Failed to save member");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-end md:items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div className="bg-white w-full md:max-w-lg rounded-t-2xl md:rounded-2xl p-6 max-h-[90vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} data-testid="member-form">
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-xl font-extrabold">{isEdit ? "Edit member" : "New member"}</h2>
          <button onClick={onClose} className="p-2 hover:bg-slate-100 rounded-lg"><X size={18} /></button>
        </div>
        <form onSubmit={submit} className="space-y-3">
          <div className="flex items-center gap-4 pb-2">
            <Avatar name={form.full_name || "?"} photo={form.photo} size={64} />
            <div className="flex-1">
              <label className="iu-label">Photo</label>
              <div className="flex gap-2 items-center">
                <label className="iu-btn-secondary !h-9 !px-3 cursor-pointer" data-testid="mf-photo-pick">
                  {photoBusy ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />} Choose file
                  <input type="file" accept="image/*" className="hidden" onChange={(e) => onPickPhoto(e.target.files?.[0])} />
                </label>
                {form.photo && (
                  <button type="button" data-testid="mf-photo-clear" onClick={() => set("photo", "")} className="iu-btn-secondary !h-9 !px-3 text-red-600">
                    <X size={14} /> Remove
                  </button>
                )}
              </div>
              <p className="text-[11px] text-slate-500 mt-1">Resized to 320 px for fast load.</p>
            </div>
          </div>
          <div>
            <label className="iu-label">Full name</label>
            <input data-testid="mf-name" value={form.full_name} onChange={(e) => set("full_name", e.target.value)} className="iu-input" />
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="iu-label">Email{isEdit && <span className="text-slate-400 normal-case font-normal"> (locked)</span>}</label>
              <input data-testid="mf-email" type="email" value={form.email} disabled={isEdit} onChange={(e) => set("email", e.target.value)} className="iu-input" />
            </div>
            <div>
              <label className="iu-label">Mobile</label>
              <input data-testid="mf-mobile" value={form.mobile} onChange={(e) => set("mobile", e.target.value)} className="iu-input" />
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="iu-label">Role</label>
              <select data-testid="mf-role" value={form.role} onChange={(e) => set("role", e.target.value)} className="iu-input">
                <option value="member">Member</option>
                <option value="admin">Admin</option>
              </select>
            </div>
            <div>
              <label className="iu-label">Category</label>
              <select data-testid="mf-category" value={form.category} onChange={(e) => set("category", e.target.value)} className="iu-input">
                <option value="athlete">Athlete</option>
                <option value="staff">Staff</option>
                <option value="coach">Coach</option>
                <option value="executive">Executive</option>
              </select>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="iu-label">Gender</label>
              <select data-testid="mf-gender" value={form.gender || ""} onChange={(e) => set("gender", e.target.value)} className="iu-input">
                <option value="">—</option>
                <option value="M">Male</option>
                <option value="F">Female</option>
                <option value="O">Other</option>
              </select>
            </div>
            <div>
              <label className="iu-label">Rank / Title</label>
              <input data-testid="mf-rank" value={form.rank} onChange={(e) => set("rank", e.target.value)} className="iu-input" placeholder="e.g. Petty Officer" />
            </div>
          </div>
          <div>
            <label className="iu-label">Institution</label>
            <select data-testid="mf-institution" value={form.institution} onChange={(e) => set("institution", e.target.value)} className="iu-input">
              <option value="">— Select institution —</option>
              {institutions.map((i) => (
                <option key={i.id} value={i.name}>{i.name}{i.short_name ? ` (${i.short_name})` : ""}</option>
              ))}
              {form.institution && !institutions.some((i) => i.name === form.institution) && (
                <option value={form.institution}>{form.institution} (legacy)</option>
              )}
            </select>
          </div>
          {form.category === "athlete" && (
            <div>
              <label className="iu-label">Fleet <span className="text-slate-400 font-normal text-[10px]">(boat class)</span></label>
              <select
                data-testid="mf-fleet"
                value={form.fleet || ""}
                onChange={(e) => set("fleet", e.target.value)}
                className="iu-input"
              >
                <option value="">— None / not yet assigned —</option>
                {fleets.map((f) => (
                  <option key={f.id} value={f.name}>{f.name}{f.short_name ? ` (${f.short_name})` : ""}</option>
                ))}
                {form.fleet && !fleets.some((f) => f.name === form.fleet) && (
                  <option value={form.fleet}>{form.fleet} (legacy)</option>
                )}
              </select>
              <p className="text-[11px] text-slate-500 mt-1">
                Manage the list under <b>Admin → Fleets</b>. Used for break-on-fleet, filtering and bulk actions.
              </p>
            </div>
          )}
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="iu-label">Work start</label>
              <input data-testid="mf-work-start" type="time" value={form.work_start} onChange={(e) => set("work_start", e.target.value)} className="iu-input" />
            </div>
            <div>
              <label className="iu-label">Work end</label>
              <input data-testid="mf-work-end" type="time" value={form.work_end} onChange={(e) => set("work_end", e.target.value)} className="iu-input" />
            </div>
          </div>
          <div>
            <label className="iu-label">Weekly off</label>
            <select data-testid="mf-weekly-off" value={form.weekly_off} onChange={(e) => set("weekly_off", e.target.value)} className="iu-input">
              <option value="monday">Monday</option>
              <option value="tuesday">Tuesday</option>
              <option value="wednesday">Wednesday</option>
              <option value="thursday">Thursday</option>
              <option value="friday">Friday</option>
              <option value="saturday">Saturday</option>
              <option value="sunday">Sunday</option>
            </select>
            <p className="text-[11px] text-slate-500 mt-1">Working on this day earns a compensatory off.</p>
          </div>
          <div>
            <label className="iu-label">{isEdit ? "Reset password (leave blank to keep)" : "Password"}</label>
            <input data-testid="mf-password" type="password" value={form.password} onChange={(e) => set("password", e.target.value)} className="iu-input" autoComplete="new-password" />
          </div>
          <div>
            <label className="iu-label">Date of birth <span className="text-slate-400 font-normal">(optional)</span></label>
            <input
              data-testid="mf-dob"
              type="date"
              value={form.date_of_birth}
              onChange={(e) => set("date_of_birth", e.target.value)}
              className="iu-input"
            />
            <p className="text-[11px] text-slate-500 mt-1">Powers a &ldquo;Happy birthday&rdquo; greeting on the Check-In screen.</p>
          </div>
          <div>
            <label className="iu-label">Overtime eligibility</label>
            <label className="flex items-start gap-2 mt-1 cursor-pointer select-none">
              <input
                data-testid="mf-ot-eligible"
                type="checkbox"
                checked={!!form.ot_eligible}
                onChange={(e) => set("ot_eligible", e.target.checked)}
                className="mt-0.5 h-4 w-4 rounded border-slate-300 text-slate-900 focus:ring-slate-800"
              />
              <span className="text-sm text-slate-700 leading-snug">
                Include this member in Overtime calculation.
                <span className="block text-[11px] text-slate-500 mt-0.5">
                  Uncheck for salaried supervisors or anyone whose contract
                  doesn&apos;t accrue OT. Athletes never accrue OT regardless.
                </span>
              </span>
            </label>
          </div>
          <div className="pt-3 mt-3 border-t border-slate-100">
            <div className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-2">Parents & guardian</div>
            <p className="text-[11px] text-slate-500 mb-3">Names + mobile numbers shown across the app and used when an athlete is late or absent. Imported via Admin → Import members → Parents.</p>
            <div className="space-y-3">
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="iu-label">Father&apos;s name</label>
                  <input data-testid="mf-father-name" value={form.father_name} onChange={(e) => set("father_name", e.target.value)} className="iu-input" />
                </div>
                <div>
                  <label className="iu-label">Father&apos;s mobile</label>
                  <input data-testid="mf-father-mobile" type="tel" value={form.father_mobile} onChange={(e) => set("father_mobile", e.target.value)} className="iu-input font-mono text-xs" placeholder="+91…" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="iu-label">Mother&apos;s name</label>
                  <input data-testid="mf-mother-name" value={form.mother_name} onChange={(e) => set("mother_name", e.target.value)} className="iu-input" />
                </div>
                <div>
                  <label className="iu-label">Mother&apos;s mobile</label>
                  <input data-testid="mf-mother-mobile" type="tel" value={form.mother_mobile} onChange={(e) => set("mother_mobile", e.target.value)} className="iu-input font-mono text-xs" placeholder="+91…" />
                </div>
              </div>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                <div>
                  <label className="iu-label">Guardian&apos;s name</label>
                  <input data-testid="mf-guardian-name" value={form.guardian_name} onChange={(e) => set("guardian_name", e.target.value)} className="iu-input" />
                </div>
                <div>
                  <label className="iu-label">Guardian&apos;s mobile</label>
                  <input data-testid="mf-guardian-mobile" type="tel" value={form.guardian_mobile} onChange={(e) => set("guardian_mobile", e.target.value)} className="iu-input font-mono text-xs" placeholder="+91…" />
                </div>
              </div>
            </div>
          </div>
          <FormErrorBanner
            error={formErr.error}
            requestId={formErr.requestId}
            onDismiss={formErr.clear}
            testId="mf-submit-error"
          />
          <button data-testid="mf-submit" type="submit" disabled={busy} className="iu-btn-primary w-full">
            {busy ? <Loader2 className="animate-spin" size={16} /> : (isEdit ? "Save changes" : "Create member")}
          </button>
        </form>
      </div>
    </div>
  );
}
