import { SettingsW300 } from "@material-symbols-svg/react/rounded/icons/settings";

import { iconProps, type IconProps } from "./icon-props";

export function SettingsIcon(props: IconProps) {
  return <SettingsW300 {...iconProps(props)} />;
}
