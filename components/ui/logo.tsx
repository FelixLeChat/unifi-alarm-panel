import * as React from "react";
import { cn } from "@/lib/utils";

// Placeholder mark (Material Symbols "shield_lock", Apache-2.0) until the project has its own logo. Inline SVG in `currentColor`, so `text-foreground` themes it in both modes.
const SHIELD_PATH = "M390-320h180q13 0 21.5-8.5T600-350v-140q0-13-8.5-21.5T570-520h-10v-40q0-33-23.5-56.5T480-640q-33 0-56.5 23.5T400-560v40h-10q-13 0-21.5 8.5T360-490v140q0 13 8.5 21.5T390-320Zm40-200v-40q0-20 15-33.5t35-13.5q20 0 35 13.5t15 33.5v40H430Zm40.5 435q-4.5-1-9.5-3-139-47-220-168.5T160-523v-196q0-19 11-34.5t28-22.5l260-97q11-4 21-4t21 4l260 97q17 7 28 22.5t11 34.5v196q0 145-81 266.5T499-88q-5 2-9.5 3t-9.5 1q-5 0-9.5-1Z";

type LogoProps = React.ComponentProps<"svg"> & {
  // Set when visible text next to the logo already names the app, so screen readers don't hear it twice.
  decorative?: boolean;
};

function a11yProps(decorative?: boolean) {
  return decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "UniFi Alarm Panel" };
}

function Logomark({ decorative, className, ...props }: LogoProps) {
  return (
    <svg viewBox="0 -960 960 960" fill="currentColor" className={cn("size-6", className)} {...a11yProps(decorative)} {...props}>
      <path d={SHIELD_PATH} />
    </svg>
  );
}

// Mark plus wordmark. The wordmark is SVG text so the component keeps one <svg> root and sizes from its height.
function Logo({ decorative, className, ...props }: LogoProps) {
  return (
    <svg viewBox="0 0 640 120" fill="currentColor" className={cn("h-7 w-auto", className)} {...a11yProps(decorative)} {...props}>
      <svg x="0" y="0" width="120" height="120" viewBox="0 -960 960 960">
        <path d={SHIELD_PATH} />
      </svg>
      <text x="136" y="84" fontFamily="var(--font-figtree), system-ui, sans-serif" fontSize="72" fontWeight="600" letterSpacing="-1">
        Alarm Panel
      </text>
    </svg>
  );
}

export { Logo, Logomark };
