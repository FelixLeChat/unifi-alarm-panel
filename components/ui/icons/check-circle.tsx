import { CheckCircleW300 } from "@material-symbols-svg/react/rounded/icons/check-circle"

import { iconProps, type IconProps } from "./icon-props"

export function CheckCircleIcon(props: IconProps) {
  return <CheckCircleW300 {...iconProps(props)} />
}
