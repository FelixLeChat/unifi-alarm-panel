import { CloseW300 } from "@material-symbols-svg/react/rounded/icons/close"

import { iconProps, type IconProps } from "./icon-props"

export function CloseIcon(props: IconProps) {
  return <CloseW300 {...iconProps(props)} />
}
