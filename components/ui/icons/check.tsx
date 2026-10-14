import { CheckW300 } from "@material-symbols-svg/react/rounded/icons/check"

import { iconProps, type IconProps } from "./icon-props"

export function CheckIcon(props: IconProps) {
  return <CheckW300 {...iconProps(props)} />
}
