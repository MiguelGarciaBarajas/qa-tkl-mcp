import { Icon, type IconName } from "./Icon";

interface PageHeaderProps {
  eyebrow: string;
  title: string;
  description: string;
  icon: IconName;
  summary?: string;
}

export function PageHeader({ eyebrow, title, description, icon, summary }: PageHeaderProps) {
  return (
    <div className="page-heading">
      <div>
        <span className="page-heading__eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p className="page__hint">{description}</p>
      </div>
      {summary && (
        <div className="page-heading__summary">
          <Icon name={icon} size={19} />
          <span>{summary}</span>
        </div>
      )}
    </div>
  );
}
