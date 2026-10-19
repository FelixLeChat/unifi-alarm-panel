import { LogoutW300 } from "@material-symbols-svg/react/rounded/icons/logout";

import { iconProps, type IconProps } from "./icon-props";

export function LogoutIcon(props: IconProps) {
  return <LogoutW300 {...iconProps(props)} />;
}
