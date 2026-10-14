import { ArrowBackW300 } from "@material-symbols-svg/react/rounded/icons/arrow-back"

import { iconProps, type IconProps } from "./icon-props"

export function ArrowBackIcon(props: IconProps) {
  return <ArrowBackW300 {...iconProps(props)} />
}
