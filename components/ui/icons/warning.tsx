import { WarningW300 } from "@material-symbols-svg/react/rounded/icons/warning";

import { iconProps, type IconProps } from "./icon-props";

export function WarningIcon(props: IconProps) {
  return <WarningW300 {...iconProps(props)} />;
}
