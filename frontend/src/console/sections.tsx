import React, { useState, useEffect, useCallback, useRef } from "react";
import { View, Text, StyleSheet, Pressable, ScrollView } from "react-native";
import QRCode from "react-native-qrcode-svg";
import * as DocumentPicker from "expo-document-picker";
import { Ionicons } from "@expo/vector-icons";
import { api, ApiError, downloadFileWeb, uploadFileWeb } from "@/src/api/client";
import { useToast } from "@/src/context/ToastContext";
import { colors, spacing, radius, font, categoryLabel } from "@/src/theme";
import { Avatar } from "@/src/components/ui";
import {
  Panel,
  SectionTitle,
  StatTile,
  Field,
  WInput,
  WButton,
  SearchBar,
  Chip,
  Pill,
  WModal,
  Empty,
  Loader,
  tableStyles as T,
  cc,
} from "@/src/console/ConsoleUI";

type Member = {
  id: string;
  full_name: string;
  email: string;
  role: string;
  category: string;
  rank?: string | null;
  mobile?: string | null;
  work_start?: string | null;
  work_end?: string | null;
  photo?: string | null;
};

/* ============================== DASHBOARD ============================== */
export const Dashboard: React.FC<{ go: (k: string) => void }> = ({ go }) => {
  const [summary, setSummary] = useState<any>(null);
  const [presence, setPresence] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      const [s, p] = await Promise.all([api.get<any>("/admin/summary"), api.get<any>("/presence")]);
      setSummary(s);
      setPresence(p);
    } catch {}
  }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const onCampus = (presence?.members || []).filter((m: any) => m.status === "on_campus");

  return (
    <View>
      <SectionTitle title="Dashboard" subtitle="Live overview of campus attendance" />
      <View style={styles.statRow}>
        <StatTile label="On Campus" value={summary?.on_campus ?? 0} icon="people" color={colors.success} />
        <StatTile label="Pending Leaves" value={summary?.pending_leaves ?? 0} icon="hourglass" color={colors.warning} />
        <StatTile label="On Leave / Tour" value={summary?.on_leave_tour ?? 0} icon="airplane" color={colors.info} />
        <StatTile label="Total Members" value={summary?.total_members ?? 0} icon="id-card" color={colors.brandSecondary} />
      </View>

      <View style={styles.dashRow}>
        <Panel style={{ flex: 2 }}>
          <View style={styles.panelHead}>
            <Text style={styles.panelTitle}>Currently on Campus ({onCampus.length})</Text>
            <Pressable onPress={() => go("presence")}><Text style={styles.link}>View board →</Text></Pressable>
          </View>
          {onCampus.length === 0 ? (
            <Empty icon="boat-outline" text="No one is on campus right now" />
          ) : (
            onCampus.slice(0, 8).map((m: any) => (
              <View key={m.id} style={styles.miniRow}>
                <Avatar name={m.full_name} photo={m.photo} size={36} ring={colors.success} />
                <View style={{ flex: 1 }}>
                  <Text style={styles.miniName}>{m.full_name}</Text>
                  <Text style={styles.miniMeta}>{m.detail}</Text>
                </View>
                {m.flagged && <Pill status="exited" />}
                <Pill status={m.status} />
              </View>
            ))
          )}
        </Panel>

        <Panel style={{ flex: 1 }}>
          <View style={styles.panelHead}>
            <Text style={styles.panelTitle}>Quick Actions</Text>
          </View>
          <View style={{ padding: spacing.lg, gap: spacing.sm }}>
            {[
              { k: "members", label: "Manage Members", icon: "people-outline" },
              { k: "import", label: "Bulk Import", icon: "cloud-upload-outline" },
              { k: "approvals", label: "Leave Approvals", icon: "checkmark-done-outline" },
              { k: "reports", label: "Reports & Export", icon: "bar-chart-outline" },
              { k: "settings", label: "Office Settings", icon: "settings-outline" },
            ].map((a) => (
              <Pressable key={a.k} onPress={() => go(a.k)} style={styles.quickRow}>
                <Ionicons name={a.icon as never} size={18} color={colors.brandSecondary} />
                <Text style={styles.quickLabel}>{a.label}</Text>
                <Ionicons name="chevron-forward" size={16} color={colors.muted} />
              </Pressable>
            ))}
          </View>
        </Panel>
      </View>
    </View>
  );
};

/* ============================== PRESENCE BOARD ============================== */
export const PresenceBoard: React.FC = () => {
  const toast = useToast();
  const [data, setData] = useState<any>(null);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState("all");
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);

  const load = useCallback(async () => {
    try {
      const p = await api.get<any>("/presence");
      if (mounted.current) setData(p);
    } catch {}
  }, []);
  useEffect(() => {
    mounted.current = true;
    load();
    const t = setInterval(load, 15000);
    return () => {
      mounted.current = false;
      clearInterval(t);
    };
  }, [load]);

  const toggle = async (m: any) => {
    setBusy(m.id);
    try {
      const res = await api.post<any>(`/admin/attendance/toggle/${m.id}`, {});
      toast.show(`${m.full_name} ${res.action === "checkin" ? "checked in" : "checked out"}`, "success");
      await load();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed", "error");
    } finally {
      setBusy(null);
    }
  };

  const FILTERS = [
    { k: "all", label: "All" },
    { k: "on_campus", label: "On Campus" },
    { k: "exited", label: "Exited" },
    { k: "on_tour", label: "On Tour" },
    { k: "on_leave", label: "On Leave" },
  ];
  const counts = data?.counts || {};
  const members = (data?.members || []).filter(
    (m: any) =>
      (filter === "all" || m.status === filter) &&
      (!q || m.full_name.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <View>
      <SectionTitle
        title="Presence Board"
        subtitle="Live roster · auto-refreshes every 15s"
        right={<SearchBar value={q} onChange={setQ} placeholder="Search member…" testID="presence-search" />}
      />
      <View style={styles.chipRow}>
        {FILTERS.map((f) => (
          <Chip
            key={f.k}
            label={f.label}
            active={filter === f.k}
            onPress={() => setFilter(f.k)}
            count={f.k === "all" ? counts.total : counts[f.k]}
            testID={`presence-filter-${f.k}`}
          />
        ))}
      </View>
      <Panel>
        <View style={T.head}>
          <Text style={[T.headText, { flex: 2 }]}>Member</Text>
          <Text style={[T.headText, { flex: 1 }]}>Category</Text>
          <Text style={[T.headText, { flex: 1.4 }]}>Status</Text>
          <Text style={[T.headText, { flex: 1.4 }]}>Detail</Text>
          <Text style={[T.headText, { width: 130, textAlign: "right" }]}>Action</Text>
        </View>
        {!data ? (
          <Loader />
        ) : members.length === 0 ? (
          <Empty icon="people-outline" text="No members match" />
        ) : (
          members.map((m: any) => (
            <View key={m.id} style={T.row} testID={`board-row-${m.id}`}>
              <View style={{ flex: 2, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <Avatar name={m.full_name} photo={m.photo} size={36} ring={m.status === "on_campus" ? colors.success : undefined} />
                <View>
                  <Text style={styles.cellName}>{m.full_name}</Text>
                  {!!m.rank && <Text style={styles.cellSub}>{m.rank}</Text>}
                </View>
              </View>
              <Text style={[T.cell, { flex: 1 }]}>{categoryLabel[m.category] || m.category}</Text>
              <View style={{ flex: 1.4, flexDirection: "row", gap: 6, alignItems: "center" }}>
                <Pill status={m.status} />
                {m.flagged && <Text style={styles.offsite}>off-site</Text>}
              </View>
              <Text style={[T.cell, { flex: 1.4, color: colors.muted }]}>{m.detail}</Text>
              <View style={{ width: 130, alignItems: "flex-end" }}>
                <WButton
                  small
                  title={m.status === "on_campus" ? "Check out" : "Check in"}
                  variant={m.status === "on_campus" ? "danger" : "success"}
                  loading={busy === m.id}
                  onPress={() => toggle(m)}
                  testID={`toggle-${m.id}`}
                />
              </View>
            </View>
          ))
        )}
      </Panel>
    </View>
  );
};

/* ============================== MEMBERS ============================== */
const CATS = ["sailor", "staff", "coach"] as const;

export const MembersSection: React.FC = () => {
  const toast = useToast();
  const [members, setMembers] = useState<Member[]>([]);
  const [loading, setLoading] = useState(true);
  const [q, setQ] = useState("");
  const [cat, setCat] = useState("all");
  const [editing, setEditing] = useState<Member | null>(null);
  const [showForm, setShowForm] = useState(false);
  const [qrMember, setQrMember] = useState<any>(null);

  const load = useCallback(async () => {
    try {
      setMembers(await api.get<Member[]>("/members"));
    } catch {}
    setLoading(false);
  }, []);
  useEffect(() => { load(); }, [load]);

  const remove = async (m: Member) => {
    try {
      await api.del(`/members/${m.id}`);
      toast.show(`Removed ${m.full_name}`, "success");
      load();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed", "error");
    }
  };

  const openQr = async (m: Member) => {
    try {
      setQrMember(await api.get<any>(`/members/${m.id}/card`));
    } catch {
      toast.show("Could not load card", "error");
    }
  };

  const filtered = members.filter(
    (m) =>
      (cat === "all" || m.category === cat) &&
      (!q ||
        m.full_name.toLowerCase().includes(q.toLowerCase()) ||
        (m.mobile || "").includes(q) ||
        m.email.toLowerCase().includes(q.toLowerCase()))
  );

  return (
    <View>
      <SectionTitle
        title="Members"
        subtitle={`${members.length} total`}
        right={
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <SearchBar value={q} onChange={setQ} placeholder="Search name, mobile, email" testID="members-search" />
            <WButton title="Add Member" icon="person-add" onPress={() => { setEditing(null); setShowForm(true); }} testID="add-member-button" />
          </View>
        }
      />
      <View style={styles.chipRow}>
        {["all", ...CATS].map((c) => (
          <Chip key={c} label={c === "all" ? "All" : categoryLabel[c]} active={cat === c} onPress={() => setCat(c)} testID={`members-cat-${c}`} />
        ))}
      </View>
      <Panel>
        <View style={T.head}>
          <Text style={[T.headText, { flex: 2 }]}>Name</Text>
          <Text style={[T.headText, { flex: 1.2 }]}>Mobile</Text>
          <Text style={[T.headText, { flex: 1 }]}>Category</Text>
          <Text style={[T.headText, { flex: 1.2 }]}>Timings</Text>
          <Text style={[T.headText, { width: 180, textAlign: "right" }]}>Actions</Text>
        </View>
        {loading ? (
          <Loader />
        ) : filtered.length === 0 ? (
          <Empty icon="people-outline" text="No members yet — add or bulk-import them" />
        ) : (
          filtered.map((m) => (
            <View key={m.id} style={T.row} testID={`member-row-${m.id}`}>
              <View style={{ flex: 2, flexDirection: "row", alignItems: "center", gap: spacing.md }}>
                <Avatar name={m.full_name} photo={m.photo} size={36} />
                <View>
                  <View style={{ flexDirection: "row", alignItems: "center", gap: 6 }}>
                    <Text style={styles.cellName}>{m.full_name}</Text>
                    {m.role === "admin" && <View style={styles.adminTag}><Text style={styles.adminTagText}>ADMIN</Text></View>}
                  </View>
                  <Text style={styles.cellSub}>{m.email}{m.rank ? ` · ${m.rank}` : ""}</Text>
                </View>
              </View>
              <Text style={[T.cell, { flex: 1.2 }]}>{m.mobile || "—"}</Text>
              <Text style={[T.cell, { flex: 1 }]}>{categoryLabel[m.category] || m.category}</Text>
              <Text style={[T.cell, { flex: 1.2, color: colors.muted }]}>
                {m.work_start && m.work_end ? `${m.work_start}–${m.work_end}` : "Default"}
              </Text>
              <View style={{ width: 180, flexDirection: "row", justifyContent: "flex-end", gap: spacing.xs }}>
                <IconBtn icon="qr-code-outline" onPress={() => openQr(m)} testID={`qr-${m.id}`} />
                <IconBtn icon="create-outline" onPress={() => { setEditing(m); setShowForm(true); }} testID={`edit-${m.id}`} />
                {m.role !== "admin" && <IconBtn icon="trash-outline" color={colors.error} onPress={() => remove(m)} testID={`delete-${m.id}`} />}
              </View>
            </View>
          ))
        )}
      </Panel>

      {showForm && <MemberForm member={editing} onClose={() => setShowForm(false)} onSaved={() => { setShowForm(false); load(); }} />}

      <WModal visible={!!qrMember} onClose={() => setQrMember(null)} title="Member QR Card" width={380}>
        {qrMember && (
          <View style={{ alignItems: "center", gap: spacing.lg }}>
            <Text style={styles.qrName}>{qrMember.full_name}</Text>
            <Text style={styles.cellSub}>{qrMember.rank ? `${qrMember.rank} · ` : ""}{categoryLabel[qrMember.category]}</Text>
            <View style={styles.qrBox}><QRCode value={qrMember.personal_qr} size={200} /></View>
            <Text style={styles.qrToken}>{qrMember.personal_qr}</Text>
            <Text style={styles.cellSub}>Print and hand to the member. Anyone can scan it at the gate.</Text>
          </View>
        )}
      </WModal>
    </View>
  );
};

const IconBtn: React.FC<{ icon: string; onPress: () => void; color?: string; testID?: string }> = ({ icon, onPress, color, testID }) => (
  <Pressable testID={testID} onPress={onPress} style={styles.iconBtn}>
    <Ionicons name={icon as never} size={18} color={color || colors.brandSecondary} />
  </Pressable>
);

const MemberForm: React.FC<{ member: Member | null; onClose: () => void; onSaved: () => void }> = ({ member, onClose, onSaved }) => {
  const toast = useToast();
  const editing = !!member;
  const [fullName, setFullName] = useState(member?.full_name || "");
  const [email, setEmail] = useState(member?.email || "");
  const [password, setPassword] = useState("");
  const [mobile, setMobile] = useState(member?.mobile || "");
  const [rank, setRank] = useState(member?.rank || "");
  const [ws, setWs] = useState(member?.work_start || "");
  const [we, setWe] = useState(member?.work_end || "");
  const [category, setCategory] = useState<(typeof CATS)[number]>((member?.category as never) || "sailor");
  const [saving, setSaving] = useState(false);

  const timeOk = (s: string) => s === "" || /^\d{1,2}:\d{2}$/.test(s);

  const save = async () => {
    if (!fullName.trim()) return toast.show("Enter full name", "error");
    if (!editing && (!email.trim() || !password)) return toast.show("Email and password required", "error");
    if (!timeOk(ws) || !timeOk(we)) return toast.show("Timings must be HH:MM or blank", "error");
    setSaving(true);
    try {
      const payload: any = {
        full_name: fullName.trim(),
        rank: rank.trim() || null,
        mobile: mobile.trim() || null,
        work_start: ws.trim() || null,
        work_end: we.trim() || null,
        category,
      };
      if (editing) {
        if (password) payload.password = password;
        await api.patch(`/members/${member!.id}`, payload);
        toast.show("Member updated", "success");
      } else {
        await api.post("/members", { ...payload, email: email.trim().toLowerCase(), password, role: "member" });
        toast.show("Member added", "success");
      }
      onSaved();
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Failed", "error");
    } finally {
      setSaving(false);
    }
  };

  return (
    <WModal visible onClose={onClose} title={editing ? "Edit Member" : "Add Member"}>
      <Field label="Full Name"><WInput value={fullName} onChangeText={setFullName} placeholder="e.g. Arjun Nair" testID="form-name" /></Field>
      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Field label={`Email${editing ? " (locked)" : ""}`}>
          <WInput value={email} onChangeText={setEmail} editable={!editing} autoCapitalize="none" placeholder="name@academy.in" testID="form-email" style={editing && { opacity: 0.6 }} />
        </Field>
        <Field label="Mobile"><WInput value={mobile} onChangeText={setMobile} placeholder="9876543210" testID="form-mobile" /></Field>
      </View>
      <Field label={editing ? "New Password (optional)" : "Password"}>
        <WInput value={password} onChangeText={setPassword} secureTextEntry placeholder={editing ? "Leave blank to keep" : "Min 4 chars"} testID="form-password" />
      </Field>
      <Field label="Rank / Title"><WInput value={rank} onChangeText={setRank} placeholder="e.g. Petty Officer" testID="form-rank" /></Field>
      <View style={{ flexDirection: "row", gap: spacing.md }}>
        <Field label="Custom start (HH:MM, blank=default)"><WInput value={ws} onChangeText={setWs} placeholder="08:00" testID="form-ws" /></Field>
        <Field label="Custom end (HH:MM, blank=default)"><WInput value={we} onChangeText={setWe} placeholder="17:00" testID="form-we" /></Field>
      </View>
      <Field label="Category">
        <View style={{ flexDirection: "row", gap: spacing.sm, marginTop: spacing.xs }}>
          {CATS.map((c) => (
            <Chip key={c} label={categoryLabel[c]} active={category === c} onPress={() => setCategory(c)} testID={`form-cat-${c}`} />
          ))}
        </View>
      </Field>
      <View style={{ flexDirection: "row", gap: spacing.md, marginTop: spacing.xl, justifyContent: "flex-end" }}>
        <WButton title="Cancel" variant="ghost" onPress={onClose} />
        <WButton title={editing ? "Save Changes" : "Add Member"} icon="checkmark" loading={saving} onPress={save} testID="save-member" />
      </View>
    </WModal>
  );
};

/* ============================== APPROVALS ============================== */
export const ApprovalsSection: React.FC = () => {
  const toast = useToast();
  const [tab, setTab] = useState<"pending" | "approved" | "rejected">("pending");
  const [leaves, setLeaves] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLeaves(await api.get<any[]>(`/leaves?status_filter=${tab}`));
    } catch {}
    setLoading(false);
  }, [tab]);
  useEffect(() => { load(); }, [load]);

  const decide = async (l: any, status: string) => {
    try {
      await api.patch(`/leaves/${l.id}`, { status });
      toast.show(`${l.member_name}'s ${l.type} ${status}`, "success");
      load();
    } catch {
      toast.show("Action failed", "error");
    }
  };

  return (
    <View>
      <SectionTitle title="Leave & Tour Approvals" subtitle="Review and decide requests" />
      <View style={styles.chipRow}>
        {(["pending", "approved", "rejected"] as const).map((t) => (
          <Chip key={t} label={t[0].toUpperCase() + t.slice(1)} active={tab === t} onPress={() => setTab(t)} testID={`approvals-${t}`} />
        ))}
      </View>
      {loading ? (
        <Loader />
      ) : leaves.length === 0 ? (
        <Panel><Empty icon="checkmark-done-circle-outline" text={`No ${tab} requests`} /></Panel>
      ) : (
        <View style={{ gap: spacing.md }}>
          {leaves.map((l) => (
            <Panel key={l.id} style={{ padding: spacing.lg }}>
              <View style={{ flexDirection: "row", alignItems: "center" }}>
                <View style={[styles.leaveIcon, { backgroundColor: l.type === "leave" ? "#FEF3C7" : "#FFEDD5" }]}>
                  <Ionicons name={l.type === "leave" ? "bed-outline" : "airplane-outline"} size={18} color={l.type === "leave" ? colors.warning : colors.info} />
                </View>
                <View style={{ flex: 1, marginLeft: spacing.md }}>
                  <Text style={styles.cellName}>{l.member_name} · {l.type === "leave" ? "Leave" : "Tour"}</Text>
                  <Text style={styles.cellSub}>
                    {l.start_date} → {l.end_date}{l.location ? `  ·  📍 ${l.location}` : ""}
                  </Text>
                  <Text style={[styles.cellSub, { marginTop: 2 }]}>{l.reason}</Text>
                </View>
                {tab === "pending" && (
                  <View style={{ flexDirection: "row", gap: spacing.sm }}>
                    <WButton small title="Reject" variant="ghost" onPress={() => decide(l, "rejected")} testID={`reject-${l.id}`} />
                    <WButton small title="Approve" variant="success" icon="checkmark" onPress={() => decide(l, "approved")} testID={`approve-${l.id}`} />
                  </View>
                )}
              </View>
            </Panel>
          ))}
        </View>
      )}
    </View>
  );
};

/* ============================== REPORTS ============================== */
function isoDay(off = 0) { const d = new Date(); d.setDate(d.getDate() + off); return d.toISOString().slice(0, 10); }
function weekStart() { const d = new Date(); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d.toISOString().slice(0, 10); }
function monthStart() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10); }

export const ReportsSection: React.FC = () => {
  const toast = useToast();
  const [mode, setMode] = useState<"hours" | "daily">("hours");
  const [range, setRange] = useState<"week" | "month">("week");
  const [hours, setHours] = useState<any[]>([]);
  const [daily, setDaily] = useState<any>(null);
  const [loading, setLoading] = useState(false);

  const period = () => (range === "week" ? { start: weekStart(), end: isoDay() } : { start: monthStart(), end: isoDay() });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      if (mode === "hours") {
        const p = period();
        const r = await api.get<any>(`/reports/hours?start=${p.start}&end=${p.end}`);
        setHours(r.rows);
      } else {
        setDaily(await api.get<any>(`/reports/daily?on=${isoDay()}`));
      }
    } catch { toast.show("Failed to load", "error"); }
    setLoading(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode, range]);
  useEffect(() => { load(); }, [load]);

  const doExport = async (fmt: "csv" | "pdf") => {
    try {
      const p = period();
      const path = mode === "hours" ? `/reports/hours/export?start=${p.start}&end=${p.end}&fmt=${fmt}` : `/reports/daily/export?on=${isoDay()}&fmt=${fmt}`;
      await downloadFileWeb(path, `${mode}_report_${isoDay()}.${fmt}`);
      toast.show(`Exported ${fmt.toUpperCase()}`, "success");
    } catch { toast.show("Export failed", "error"); }
  };

  return (
    <View>
      <SectionTitle
        title="Reports & Export"
        subtitle="Attendance hours and daily leave/tour"
        right={
          <View style={{ flexDirection: "row", gap: spacing.sm }}>
            <WButton title="Export CSV" variant="ghost" icon="document-outline" onPress={() => doExport("csv")} testID="export-csv" />
            <WButton title="Export PDF" icon="download-outline" onPress={() => doExport("pdf")} testID="export-pdf" />
          </View>
        }
      />
      <View style={styles.chipRow}>
        <Chip label="Hours & Attendance" active={mode === "hours"} onPress={() => setMode("hours")} testID="report-hours" />
        <Chip label="Daily Leave & Tour" active={mode === "daily"} onPress={() => setMode("daily")} testID="report-daily" />
        {mode === "hours" && <View style={{ width: spacing.lg }} />}
        {mode === "hours" && <Chip label="This Week" active={range === "week"} onPress={() => setRange("week")} />}
        {mode === "hours" && <Chip label="This Month" active={range === "month"} onPress={() => setRange("month")} />}
      </View>

      {loading ? (
        <Loader />
      ) : mode === "hours" ? (
        <Panel>
          <View style={T.head}>
            <Text style={[T.headText, { flex: 2 }]}>Member</Text>
            <Text style={[T.headText, { flex: 1 }]}>Category</Text>
            <Text style={[T.headText, { width: 90, textAlign: "right" }]}>Hours</Text>
            <Text style={[T.headText, { width: 90, textAlign: "right" }]}>Days</Text>
            <Text style={[T.headText, { width: 110, textAlign: "right" }]}>Attendance</Text>
          </View>
          {hours.length === 0 ? (
            <Empty icon="bar-chart-outline" text="No data for this period" />
          ) : (
            hours.map((r, i) => (
              <View key={i} style={T.row}>
                <Text style={[T.cell, { flex: 2, fontWeight: "600" }]}>{r.member_name}</Text>
                <Text style={[T.cell, { flex: 1, color: colors.muted }]}>{categoryLabel[r.category] || r.category}</Text>
                <Text style={[T.cell, { width: 90, textAlign: "right" }]}>{r.total_hours}</Text>
                <Text style={[T.cell, { width: 90, textAlign: "right" }]}>{r.days_present}</Text>
                <Text style={[T.cell, { width: 110, textAlign: "right", fontWeight: "700", color: r.attendance_pct >= 60 ? colors.success : colors.muted }]}>
                  {r.attendance_pct}%
                </Text>
              </View>
            ))
          )}
        </Panel>
      ) : (
        <View style={styles.dashRow}>
          <DailyGroup title="On Tour" icon="airplane" color={colors.info} items={daily?.on_tour || []} tour />
          <DailyGroup title="On Leave" icon="bed" color={colors.warning} items={daily?.on_leave || []} />
        </View>
      )}
    </View>
  );
};

const DailyGroup: React.FC<{ title: string; icon: string; color: string; items: any[]; tour?: boolean }> = ({ title, icon, color, items, tour }) => (
  <Panel style={{ flex: 1 }}>
    <View style={styles.panelHead}>
      <View style={{ flexDirection: "row", alignItems: "center", gap: spacing.sm }}>
        <Ionicons name={icon as never} size={18} color={color} />
        <Text style={styles.panelTitle}>{title} ({items.length})</Text>
      </View>
    </View>
    {items.length === 0 ? (
      <Empty icon={`${icon}-outline` as never} text={`Nobody ${tour ? "on tour" : "on leave"} today`} />
    ) : (
      items.map((it, i) => (
        <View key={i} style={styles.miniRow}>
          <View style={{ flex: 1 }}>
            <Text style={styles.miniName}>{it.member_name}</Text>
            <Text style={styles.miniMeta}>{tour && it.location ? `📍 ${it.location} · ` : ""}Till {it.end_date}</Text>
          </View>
        </View>
      ))
    )}
  </Panel>
);

/* ============================== OFFICE SETTINGS ============================== */
export const OfficeSettingsSection: React.FC = () => {
  const toast = useToast();
  const [o, setO] = useState<any>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => { api.get<any>("/office").then(setO).catch(() => {}); }, []);

  const set = (k: string, v: any) => setO((p: any) => ({ ...p, [k]: v }));

  const save = async () => {
    const lat = parseFloat(o.latitude), lng = parseFloat(o.longitude), rad = parseInt(o.radius_m, 10);
    if (isNaN(lat) || lat < -90 || lat > 90) return toast.show("Latitude -90..90", "error");
    if (isNaN(lng) || lng < -180 || lng > 180) return toast.show("Longitude -180..180", "error");
    if (isNaN(rad) || rad < 10 || rad > 100) return toast.show("Radius 10..100m", "error");
    if (!/^\d{1,2}:\d{2}$/.test(o.default_work_start) || !/^\d{1,2}:\d{2}$/.test(o.default_work_end)) return toast.show("Timings HH:MM", "error");
    setSaving(true);
    try {
      await api.put("/office", {
        name: o.name || "Campus Office", latitude: lat, longitude: lng, radius_m: rad,
        default_work_start: o.default_work_start, default_work_end: o.default_work_end,
      });
      toast.show("Office settings saved", "success");
    } catch (e) { toast.show(e instanceof ApiError ? e.message : "Failed", "error"); }
    finally { setSaving(false); }
  };

  if (!o) return <Loader />;
  return (
    <View>
      <SectionTitle title="Office Settings" subtitle="Geofence location and default working hours" />
      <Panel style={{ padding: spacing.xl, maxWidth: 720 }}>
        <Field label="Office Name"><WInput value={o.name} onChangeText={(v) => set("name", v)} testID="office-name" /></Field>
        <View style={{ flexDirection: "row", gap: spacing.md }}>
          <Field label="Latitude"><WInput value={String(o.latitude)} onChangeText={(v) => set("latitude", v)} testID="office-lat" /></Field>
          <Field label="Longitude"><WInput value={String(o.longitude)} onChangeText={(v) => set("longitude", v)} testID="office-lng" /></Field>
          <Field label="Radius (m, ≤100)"><WInput value={String(o.radius_m)} onChangeText={(v) => set("radius_m", v)} testID="office-radius" /></Field>
        </View>
        <View style={{ flexDirection: "row", gap: spacing.md }}>
          <Field label="Default Start (HH:MM)"><WInput value={o.default_work_start} onChangeText={(v) => set("default_work_start", v)} testID="office-start" /></Field>
          <Field label="Default End (HH:MM)"><WInput value={o.default_work_end} onChangeText={(v) => set("default_work_end", v)} testID="office-end" /></Field>
        </View>
        <View style={styles.tip}>
          <Ionicons name="bulb-outline" size={16} color={colors.muted} />
          <Text style={styles.tipText}>Tip: open Google Maps, long-press your office, and copy the latitude, longitude.</Text>
        </View>
        <View style={{ marginTop: spacing.xl, alignItems: "flex-start" }}>
          <WButton title="Save Settings" icon="save-outline" loading={saving} onPress={save} testID="save-office" />
        </View>
      </Panel>
    </View>
  );
};

/* ============================== OFFICE QR ============================== */
export const OfficeQRSection: React.FC = () => {
  const toast = useToast();
  const [o, setO] = useState<any>(null);
  const [busy, setBusy] = useState(false);
  const load = () => api.get<any>("/office").then(setO).catch(() => {});
  useEffect(() => { load(); }, []);

  const regen = async () => {
    setBusy(true);
    try {
      const r = await api.post<any>("/office/regenerate-qr");
      setO((p: any) => ({ ...p, qr_token: r.qr_token }));
      toast.show("New QR generated — old one now invalid", "success");
    } catch { toast.show("Failed", "error"); }
    finally { setBusy(false); }
  };

  if (!o) return <Loader />;
  return (
    <View>
      <SectionTitle title="Office Station QR" subtitle="Print and display at the gate" />
      <Panel style={{ padding: spacing.xl, alignItems: "center", maxWidth: 460, gap: spacing.lg }}>
        <View style={styles.qrBox}><QRCode value={o.qr_token} size={240} /></View>
        <Text style={styles.qrToken}>{o.qr_token}</Text>
        <Text style={styles.cellSub}>{o.name} · {Number(o.latitude).toFixed(4)}, {Number(o.longitude).toFixed(4)} · {o.radius_m}m</Text>
        <WButton title="Regenerate QR" variant="ghost" icon="refresh-outline" loading={busy} onPress={regen} testID="regen-qr" />
      </Panel>
    </View>
  );
};

/* ============================== IMPORT ============================== */
export const ImportSection: React.FC = () => {
  const toast = useToast();
  const [downloading, setDownloading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState<any>(null);

  const dl = async () => {
    setDownloading(true);
    try { await downloadFileWeb("/members/import-template", "members_template.xlsx"); toast.show("Template downloaded", "success"); }
    catch { toast.show("Download failed", "error"); }
    finally { setDownloading(false); }
  };

  const pick = async () => {
    try {
      const res = await DocumentPicker.getDocumentAsync({
        type: ["application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "application/vnd.ms-excel", "application/octet-stream"],
        copyToCacheDirectory: true,
      });
      if (res.canceled || !res.assets?.length) return;
      const asset: any = res.assets[0];
      setUploading(true);
      setResult(null);
      let file: File = asset.file;
      if (!file) {
        const blob = await (await fetch(asset.uri)).blob();
        file = new File([blob], asset.name || "members.xlsx");
      }
      const data = await uploadFileWeb<any>("/members/import", file);
      setResult(data);
      toast.show(`Imported ${data.created_count} member(s)`, "success");
    } catch (e) {
      toast.show(e instanceof ApiError ? e.message : "Import failed", "error");
    } finally {
      setUploading(false);
    }
  };

  return (
    <View>
      <SectionTitle title="Bulk Import Members" subtitle="Upload an Excel sheet to add many members at once" />
      <View style={{ flexDirection: "row", gap: spacing.lg, alignItems: "flex-start" }}>
        <Panel style={{ flex: 1, padding: spacing.xl, gap: spacing.md }}>
          <Text style={styles.panelTitle}>1 · Get the template</Text>
          <Text style={styles.cellSub}>Columns: full_name, mobile, email, password, rank, category, work_start, work_end. Only name & mobile are required.</Text>
          <WButton title="Download Template" variant="ghost" icon="download-outline" loading={downloading} onPress={dl} testID="dl-template" />
          <Text style={[styles.panelTitle, { marginTop: spacing.lg }]}>2 · Fill it & upload</Text>
          <Text style={styles.cellSub}>Blank email → made from mobile. Blank password → mobile number. Blank timings → office default.</Text>
          <WButton title="Pick Excel & Import" icon="cloud-upload-outline" loading={uploading} onPress={pick} testID="pick-import" />
        </Panel>

        <Panel style={{ flex: 1, minHeight: 200 }}>
          <View style={styles.panelHead}><Text style={styles.panelTitle}>Result</Text></View>
          {!result ? (
            <Empty icon="document-text-outline" text="Upload a file to see results" />
          ) : (
            <ScrollView style={{ maxHeight: 420 }} contentContainerStyle={{ padding: spacing.lg }}>
              <Text style={[styles.cellName, { marginBottom: spacing.sm }]}>{result.created_count} added · {result.error_count} skipped</Text>
              {result.created.map((c: any, i: number) => (
                <View key={i} style={styles.miniRow}>
                  <View style={{ flex: 1 }}>
                    <Text style={styles.miniName}>{c.full_name}</Text>
                    <Text style={styles.miniMeta}>{c.email} · {c.password}</Text>
                  </View>
                </View>
              ))}
              {result.errors.map((e: any, i: number) => (
                <Text key={i} style={styles.errRow}>Row {e.row}: {e.reason}</Text>
              ))}
            </ScrollView>
          )}
        </Panel>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  statRow: { flexDirection: "row", gap: spacing.lg, marginBottom: spacing.lg },
  dashRow: { flexDirection: "row", gap: spacing.lg, alignItems: "flex-start" },
  panelHead: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
    borderBottomWidth: 1,
    borderBottomColor: cc.border,
  },
  panelTitle: { fontSize: font.lg, fontWeight: "800", color: colors.onSurface },
  link: { fontSize: font.sm, fontWeight: "700", color: colors.brandSecondary },
  miniRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingHorizontal: spacing.lg, paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.divider },
  miniName: { fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  miniMeta: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  quickRow: { flexDirection: "row", alignItems: "center", gap: spacing.md, paddingVertical: spacing.sm },
  quickLabel: { flex: 1, fontSize: font.base, fontWeight: "600", color: colors.onSurface },
  chipRow: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginBottom: spacing.lg, flexWrap: "wrap" },
  cellName: { fontSize: font.base, fontWeight: "700", color: colors.onSurface },
  cellSub: { fontSize: font.sm, color: colors.muted, marginTop: 1 },
  offsite: { fontSize: 10, fontWeight: "700", color: "#92400E", backgroundColor: "#FEF3C7", paddingHorizontal: 5, paddingVertical: 2, borderRadius: 4 },
  adminTag: { backgroundColor: colors.brandPrimary, paddingHorizontal: 5, paddingVertical: 1, borderRadius: 4 },
  adminTagText: { color: "#fff", fontSize: 9, fontWeight: "800" },
  iconBtn: { width: 36, height: 36, borderRadius: radius.sm, backgroundColor: colors.surfaceTertiary, alignItems: "center", justifyContent: "center" },
  leaveIcon: { width: 40, height: 40, borderRadius: 10, alignItems: "center", justifyContent: "center" },
  qrBox: { padding: spacing.md, backgroundColor: "#fff", borderRadius: radius.md, borderWidth: 1, borderColor: cc.border },
  qrName: { fontSize: font.xl, fontWeight: "800", color: colors.onSurface },
  qrToken: { fontSize: font.base, fontWeight: "700", letterSpacing: 1, color: colors.onSurfaceTertiary },
  tip: { flexDirection: "row", alignItems: "center", gap: spacing.sm, marginTop: spacing.lg, backgroundColor: colors.surfaceTertiary, padding: spacing.md, borderRadius: radius.sm },
  tipText: { fontSize: font.sm, color: colors.muted },
  errRow: { fontSize: font.sm, color: colors.error, paddingVertical: 2 },
});
