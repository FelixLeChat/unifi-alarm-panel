import { PersonW300 } from "@material-symbols-svg/react/rounded/icons/person"

import { iconProps, type IconProps } from "./icon-props"

export function PersonIcon(props: IconProps) {
  return <PersonW300 {...iconProps(props)} />
}
