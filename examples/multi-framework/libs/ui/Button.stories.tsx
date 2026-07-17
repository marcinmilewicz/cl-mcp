import { Button } from "./Button";
import { Icon } from "./Icon";

export default { title: "Button", component: Button };

export const Primary = {
  args: { variant: "primary", disabled: false },
  render: (args: Record<string, unknown>) => (
    <Button disabled={false} icon={<Icon name="check" />} {...args}>
      Save
    </Button>
  ),
};
