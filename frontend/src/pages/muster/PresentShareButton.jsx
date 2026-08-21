import React, { useState } from "react";
import { Users, Share2, Loader2 } from "lucide-react";
import { api } from "../../api";
import { shareToWhatsApp } from "../../utils/shareWhatsApp";
import { buildPhotoMosaicBlob } from "../../utils/mosaicShare";
import useWhatsappGroups, { buildWhatsappHeader } from "../../hooks/useWhatsappGroups";
import { toast } from "sonner";

const fmtDay = (iso) =>
  new Date(iso + "T00:00:00").toLocaleDateString("en-GB", {
    weekday: "short", day: "numeric", month: "short", year: "numeric",
  });

function buildCaption(present, dateISO, officeName, groups) {
  // Muster present-list always targets the parents/athletes group.
  const header = buildWhatsappHeader({ audience: "athletes", groups, dateIso: dateISO });
  const head = `✅ Present today · ${fmtDay(dateISO)}`;
  if (!present.length) return `${header}\n${head}\n\n(no one has checked in yet)`;
  const names = present.slice(0, 40).map((m, i) => `${i + 1}. ${m.full_name}`);
  if (present.length > 40) names.push(`…and ${present.length - 40} more`);
  const tail = officeName ? `\n\n— ${officeName}` : "";
  return `${header}\n${head}\nTotal: ${present.length}\n\n${names.join("\n")}${tail}`;
}

/**
 * PresentShareButton — post-muster batch share of "who's here today"
 * as a single WhatsApp message with a **photo mosaic** of every
 * currently-checked-in athlete plus a text caption.
 */
export default function PresentShareButton({ officeName }) {
  const [busy, setBusy] = useState(false);
  const [hinted, setHinted] = useState(false);
  const groups = useWhatsappGroups();
  const handleClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await api.get("/muster/athletes", { mode: "checkout", scope: "athletes" });
      const present = (res.athletes || []).filter(Boolean);
      if (!present.length) {
        toast.error("Nobody is checked-in yet — nothing to share.");
        return;
      }
      const dateISO = res.date;
      let imageBlob = null;
      try {
        imageBlob = await buildPhotoMosaicBlob(
          present,
          `✅ Present today · ${fmtDay(dateISO)}`,
          `${present.length} checked-in${officeName ? " · " + officeName : ""}`,
        );
      } catch (err) { console.warn("mosaic build failed:", err); }
      // Onboarding hint the first time a coach uses this in a session
      // — tells them what to expect in the OS share sheet.
      if (!hinted) {
        toast.message("Pick WhatsApp → your group → send", {
          description: "The message and photo mosaic are already attached.",
          duration: 4200,
        });
        setHinted(true);
      }
      shareToWhatsApp({
        text: buildCaption(present, dateISO, officeName, groups),
        imageBlob,
        filename: `present_${dateISO}.jpg`,
      });
    } catch (err) {
      toast.error(err?.message || "Couldn't build the present list.");
    } finally {
      setBusy(false);
    }
  };
  const label = `Share Present List → ${groups.athletes_group_name}`;
  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={busy}
      data-testid="muster-present-share-btn"
      title={`Share today's present athletes (with photo collage) — targets the ${groups.athletes_group_name} WhatsApp group`}
      className="iu-btn iu-btn-secondary !border-emerald-300 !text-emerald-700 hover:!bg-emerald-50 disabled:opacity-60 !min-h-[44px] !px-4 !gap-1.5 whitespace-nowrap"
    >
      {busy ? <Loader2 size={16} className="animate-spin"/> : <Users size={16}/>}
      <Share2 size={14} className="ml-0.5"/>
      <span className="font-semibold">{label}</span>
    </button>
  );
}
