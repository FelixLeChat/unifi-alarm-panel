import type { SVGProps } from "react";

/**
 * Each module in this folder wraps one Material Symbols glyph (Rounded, weight
 * 300). Add an icon by copying a module and changing the glyph.
 *
 * Props every icon takes. `size` is the pixel size of the box — 16, 20
 * or 24; a Tailwind size utility on `className` wins over it, which is how most
 * of the components here set their size.
 *
 * An icon with no `label` is decorative and stays out of the accessibility tree:
 * it sits beside text that already names the thing. Pass `label` only when the
 * icon is the only thing carrying the meaning, such as an icon-only button.
 */
export type IconProps = Omit<SVGProps<SVGSVGElement>, "ref"> & {
  size?: number;
  label?: string;
};

export function iconProps({ size = 20, label, ...rest }: IconProps) {
  return label ? { size, role: "img", "aria-label": label, ...rest } : { size, "aria-hidden": true, ...rest };
}
