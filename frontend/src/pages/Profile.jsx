import React, { useEffect, useState } from "react";
import { Clock, Calendar, AlertCircle, Loader2, Camera, Save } from "lucide-react";
import { toast } from "sonner";
import { api, showApiError } from "../api";
import { useAuth } from "../auth";
import Avatar from "../components/Avatar";
import { formatTime, formatDate, categoryLabel } from "../utils";

export default function Profile() {
  const { user, refreshMe } = useAuth();
  const [stats, setStats] = useState(null);
  const [loading, setLoading] = useState(true);
  const [uploading, setUploading] = useState(false);

  useEffect(() => {
    (async () => {
      try { setStats(await api.get("/me/stats")); }
      finally { setLoading(false); }
    })();
  }, []);

  const handlePhotoSelected = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) { toast.error("Your photo is too big. Try retaking it or pick a smaller image (max 2 MB)."); return; }
    setUploading(true);
    try {
      const dataUrl = await new Promise((resolve, reject) => {
        const fr = new FileReader();
        fr.onload = () => resolve(fr.result);
        fr.onerror = reject;
        fr.readAsDataURL(file);
      });
      await api.post("/members/me/photo", { photo: dataUrl });
      await refreshMe();
      toast.success("Profile photo updated");
    } catch (err) {
      showApiError(err, "Could not upload");
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="p-4 md:p-8 max-w-4xl mx-auto">
      <div className="iu-card overflow-hidden mb-6">
        <div
          className="h-32 md:h-44 bg-cover bg-center relative"
          style={{
            backgroundImage:
              "linear-gradient(180deg, rgba(15,23,42,0.2), rgba(15,23,42,0.55)), url('https://images.unsplash.com/photo-1689846136233-de0717f3675c?crop=entropy&cs=srgb&fm=jpg&w=1600&q=85')",
          }}
        />
        <div className="px-5 md:px-8 pb-6 -mt-12 flex flex-col md:flex-row items-center md:items-end gap-4">
          <div className="relative" data-testid="profile-avatar">
            <Avatar name={user?.full_name} photo={user?.photo} size={96} />
            <label className="absolute -bottom-1 -right-1 w-9 h-9 rounded-full bg-slate-900 text-white flex items-center justify-center cursor-pointer shadow hover:bg-slate-800" title="Change photo">
              {uploading ? <Loader2 className="animate-spin" size={14}/> : <Camera size={14} />}
              <input
                data-testid="photo-input"
                type="file"
                accept="image/*"
                className="hidden"
                onChange={handlePhotoSelected}
                disabled={uploading}
              />
            </label>
          </div>
          <div className="flex-1 text-center md:text-left">
            <h1 className="text-2xl font-extrabold tracking-tight" data-testid="profile-name">{user?.full_name}</h1>
            <p className="text-sm text-slate-500 mt-0.5">
              {user?.rank ? `${user.rank} · ` : ""}{categoryLabel(user?.category)} · {user?.role === "admin" ? "Admin" : "Member"}
            </p>
            <p className="text-xs text-slate-400 mt-1">{user?.email}</p>
          </div>
        </div>
      </div>

      {loading ? (
        <div className="text-center py-10"><Loader2 className="mx-auto animate-spin text-slate-400" /></div>
      ) : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-6">
            <StatBox label="Hours this week" value={`${stats?.week_hours ?? 0}h`} Icon={Clock} />
            <StatBox label="Hours this month" value={`${stats?.month_hours ?? 0}h`} Icon={Clock} />
            <StatBox label="Days on campus" value={stats?.days_this_week ?? 0} Icon={Calendar} />
            <StatBox label="Late days" value={stats?.late_days_this_week ?? 0} Icon={AlertCircle} accent={(stats?.late_days_this_week ?? 0) > 0 ? "#F59E0B" : undefined} />
          </div>

          <section className="iu-card">
            <div className="px-5 py-4 border-b border-slate-100 flex items-center justify-between">
              <h2 className="font-extrabold tracking-tight">Recent attendance</h2>
              <span className="text-xs text-slate-400">Last 10 sessions</span>
            </div>
            {(stats?.recent || []).length === 0 ? (
              <div className="p-8 text-center text-slate-500 text-sm">No attendance logged yet.</div>
            ) : (
              <ul className="divide-y divide-slate-100">
                {stats.recent.map((s) => (
                  <li key={s.id} className="px-5 py-3 flex items-center gap-3" data-testid={`recent-${s.id}`}>
                    <div className="w-10 h-10 rounded-lg bg-slate-100 flex items-center justify-center text-slate-700"><Clock size={16}/></div>
                    <div className="flex-1 min-w-0">
                      <div className="font-semibold text-sm">{formatDate(s.date)}</div>
                      <div className="text-xs text-slate-500">
                        {formatTime(s.check_in_at)} – {s.check_out_at ? formatTime(s.check_out_at) : "Open"}
                        {s.late ? <span className="ml-2 text-amber-700 font-semibold">· Late {s.late_minutes}m</span> : null}
                      </div>
                    </div>
                    <div className="text-sm font-bold text-slate-900">{s.hours ?? "—"}{typeof s.hours === "number" ? "h" : ""}</div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </div>
  );
}

function StatBox({ label, value, Icon, accent }) {
  return (
    <div className="iu-card p-4">
      <div className="w-9 h-9 rounded-lg flex items-center justify-center bg-slate-100 text-slate-700 mb-3">
        <Icon size={16} style={accent ? { color: accent } : undefined} />
      </div>
      <div className="text-2xl font-extrabold text-slate-900">{value}</div>
      <div className="text-xs text-slate-500 font-semibold uppercase tracking-wide mt-0.5">{label}</div>
    </div>
  );
}
