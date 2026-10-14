import { StarW300 } from "@material-symbols-svg/react/rounded/icons/star"

import { iconProps, type IconProps } from "./icon-props"

export function StarIcon(props: IconProps) {
  return <StarW300 {...iconProps(props)} />
}
