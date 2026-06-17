import React, { useState } from "react";
import { X, Loader2 } from "lucide-react";
import { toast } from "sonner";
import { api } from "../../api";

export default function MemberForm({ initial, onClose, onSaved }) {
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
  });
  const [busy, setBusy] = useState(false);

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const submit = async (e) => {
    e.preventDefault();
    if (!form.full_name.trim()) { toast.error("Name is required"); return; }
    if (!isEdit && !form.email.trim()) { toast.error("Email is required"); return; }
    if (!isEdit && (form.password || "").length < 4) { toast.error("Password must be ≥ 4 chars"); return; }
    setBusy(true);
    try {
      if (isEdit) {
        const body = { ...form };
        if (!body.password) delete body.password;
        delete body.email; // backend doesn't update email
        await api.patch(`/members/${initial.id}`, body);
        toast.success("Member updated");
      } else {
        await api.post("/members", form);
        toast.success("Member created");
      }
      onSaved();
    } catch (err) {
      toast.error(err?.message || "Failed");
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
            <input data-testid="mf-institution" value={form.institution} onChange={(e) => set("institution", e.target.value)} className="iu-input" placeholder="e.g. INS Hamla, YCH Hyderabad, Naval Sailing Academy" />
          </div>
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
            <label className="iu-label">{isEdit ? "Reset password (leave blank to keep)" : "Password"}</label>
            <input data-testid="mf-password" type="password" value={form.password} onChange={(e) => set("password", e.target.value)} className="iu-input" autoComplete="new-password" />
          </div>
          <button data-testid="mf-submit" type="submit" disabled={busy} className="iu-btn-primary w-full">
            {busy ? <Loader2 className="animate-spin" size={16} /> : (isEdit ? "Save changes" : "Create member")}
          </button>
        </form>
      </div>
    </div>
  );
}
