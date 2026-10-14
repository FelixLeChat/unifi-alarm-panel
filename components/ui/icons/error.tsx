import { ErrorW300 } from "@material-symbols-svg/react/rounded/icons/error"

import { iconProps, type IconProps } from "./icon-props"

export function ErrorIcon(props: IconProps) {
  return <ErrorW300 {...iconProps(props)} />
}
