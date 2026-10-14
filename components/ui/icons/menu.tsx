import { MenuW300 } from "@material-symbols-svg/react/rounded/icons/menu"

import { iconProps, type IconProps } from "./icon-props"

export function MenuIcon(props: IconProps) {
  return <MenuW300 {...iconProps(props)} />
}
