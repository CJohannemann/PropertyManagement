import { navigate, type Route } from '../lib/route'

type Props = {
  /** Only an admin may add a property — see the capability matrix in docs/domain-model.md. */
  canAddProperty?: boolean
}

type Action = { label: string; to: Route; id?: string }

/**
 * The handful of things a landlord opens the app to do.
 *
 * Every one of these lands on a real screen with a real URL. They were held
 * back until routing existed, deliberately: a row of buttons that scrolled
 * the page a bit would look like navigation and behave like nothing.
 *
 * The spec asks for six. Four are here; "+ Add Expense" and "+ Task" want
 * data models that do not exist yet (an expense not tied to a repair has
 * nowhere to live, and there is no tasks table), and a button for a screen
 * that cannot be built is worse than no button.
 */
export function QuickActions({ canAddProperty = false }: Props) {
  const actions: Action[] = [
    { label: 'Record a payment', to: '/rent' },
    { label: 'Log a repair', to: '/maintenance' },
    { label: 'Invite a tenant', to: '/properties' },
  ]
  if (canAddProperty) actions.push({ label: 'Add a property', to: '/properties' })

  return (
    <>
      <h2 style={{ marginTop: '2rem' }}>Quick actions</h2>
      <div className="quick-actions">
        {actions.map((a) => (
          <button
            key={a.label}
            className="quick-action"
            onClick={() => navigate(a.to, { id: a.id })}
          >
            {a.label}
          </button>
        ))}
      </div>
    </>
  )
}
