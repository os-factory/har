const passthrough = (value: string) => value;

const chalk = {
  blue: passthrough,
  green: passthrough,
  red: passthrough,
  yellow: passthrough,
  bold: passthrough,
  dim: passthrough,
};

export default chalk;
