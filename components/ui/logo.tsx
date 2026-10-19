import * as React from "react";
import { cn } from "@/lib/utils";

// The mark, on a 24x24 grid, as one even-odd path so the holes stay see-through. Inline in `currentColor`, so `text-foreground` themes it in both modes. public/icon.svg and public/kiosk-band.svg are drawn from the same shape.
const MARK_PATH =
  "M12 1.6 20.6 4.8V11c0 5.6-3.6 10-8.6 11.4C7 21 3.4 16.6 3.4 11V4.8L12 1.6Z M9.400 8.200a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0 -3.4Z M14.600 8.200a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0 -3.4Z M9.400 13.200a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0 -3.4Z M14.600 13.200a1.7 1.7 0 1 0 0 3.4a1.7 1.7 0 1 0 0 -3.4Z";

type LogoProps = React.ComponentProps<"svg"> & {
  // Set when visible text next to the logo already names the app, so screen readers don't hear it twice.
  decorative?: boolean;
};

function a11yProps(decorative?: boolean) {
  return decorative ? { "aria-hidden": true } : { role: "img", "aria-label": "UniFi Alarm Panel" };
}

function Logomark({ decorative, className, ...props }: LogoProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      className={cn("size-6", className)}
      {...a11yProps(decorative)}
      {...props}
    >
      <path fillRule="evenodd" d={MARK_PATH} />
    </svg>
  );
}

// Mark plus wordmark. The wordmark is SVG text so the component keeps one <svg> root and sizes from its height.
function Logo({ decorative, className, ...props }: LogoProps) {
  return (
    <svg
      viewBox="0 0 640 120"
      fill="currentColor"
      className={cn("h-7 w-auto", className)}
      {...a11yProps(decorative)}
      {...props}
    >
      <svg x="0" y="0" width="120" height="120" viewBox="0 0 24 24">
        <path fillRule="evenodd" d={MARK_PATH} />
      </svg>
      <text
        x="136"
        y="84"
        fontFamily="var(--font-figtree), system-ui, sans-serif"
        fontSize="72"
        fontWeight="600"
        letterSpacing="-1"
      >
        Alarm Panel
      </text>
    </svg>
  );
}

export { Logo, Logomark };
