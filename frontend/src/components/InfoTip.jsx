import { Info } from "lucide-react";
import {
  Tooltip,
  TooltipTrigger,
  TooltipContent,
  TooltipProvider,
} from "./ui/tooltip";

/**
 * Small inline "ⓘ" info icon that reveals an explanatory tooltip.
 * - Works on desktop (hover) AND touch (tap focuses the button → opens).
 * - Self-contained TooltipProvider so it can be dropped in anywhere
 *   without wiring a provider at the app root.
 * - stopPropagation so tapping it never triggers a parent row/card click.
 *
 * Usage: <InfoTip id="cost-per-meal" text="Food + wages ÷ main meals (BF+L+D)." />
 */
export const InfoTip = ({
  text,
  id,
  side = "top",
  size = 13,
  className = "",
  iconClassName = "",
}) => {
  if (!text) return null;
  return (
    <TooltipProvider delayDuration={150}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); }}
            onMouseDown={(e) => e.stopPropagation()}
            aria-label="More information"
            data-testid={id ? `info-tip-${id}` : "info-tip"}
            className={`inline-flex items-center justify-center align-middle text-slate-400 hover:text-slate-600 focus:text-slate-600 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-amber-300 rounded-full transition-colors cursor-help ${className}`}
          >
            <Info size={size} strokeWidth={2.2} className={iconClassName} />
          </button>
        </TooltipTrigger>
        <TooltipContent
          side={side}
          className="max-w-[250px] leading-snug text-[11.5px] font-normal normal-case tracking-normal text-left"
        >
          {text}
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
};

export default InfoTip;
