import { LinkW300 } from "@material-symbols-svg/react/rounded/icons/link"

import { iconProps, type IconProps } from "./icon-props"

export function LinkIcon(props: IconProps) {
  return <LinkW300 {...iconProps(props)} />
}
