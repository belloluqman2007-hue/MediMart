import { useEffect, useState, type FormEvent } from 'react';
import { Link, Navigate, useNavigate } from 'react-router-dom';
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  HeartPulse,
  KeyRound,
  LockKeyhole,
  Mail,
  Pill,
  Server,
  ShieldCheck,
  Store,
  UserRound,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { loginSchema, ownerRegistrationSchema } from '@medimart/shared';
import { useApp } from '../lib/context';
import { errorMessage } from '../lib/api';
import { Brand, Button, FormError, Modal } from '../components/ui';
export function AuthPage({ register = false }: { register?: boolean }) {
  const { signIn, registerOwner, user, bootstrap, connection, runtime } = useApp();
  const navigate = useNavigate();
  const [showPassword, setShowPassword] = useState(false);
  const [help, setHelp] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    document.title = `${register ? 'Create owner account' : 'Sign in'} · MediMart`;
  }, [register]);
  if (user) return <Navigate to="/" replace />;
  const registrationUnavailable =
    register && (runtime.native || bootstrap?.required === false || bootstrap?.enabled === false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(null);
    const data = new FormData(event.currentTarget);
    const input = {
      email: String(data.get('email') || ''),
      password: String(data.get('password') || ''),
    };
    setBusy(true);
    try {
      if (register) {
        const parsed = ownerRegistrationSchema.safeParse({
          ...input,
          fullName: data.get('fullName'),
          bootstrapToken: data.get('bootstrapToken'),
        });
        if (!parsed.success) {
          setError(parsed.error.issues.map((issue) => issue.message).join(' '));
          return;
        }
        await registerOwner(parsed.data);
      } else {
        const parsed = loginSchema.safeParse(input);
        if (!parsed.success) {
          setError(parsed.error.issues.map((issue) => issue.message).join(' '));
          return;
        }
        await signIn(parsed.data);
      }
      navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="auth-page">
      <aside className="auth-story">
        <Brand inverse />
        <div className="auth-story-content">
          <span className="auth-eyebrow">
            <span />
            BUILT FOR THE WAY YOU WORK
          </span>
          <h2>
            Good business.
            <br />
            Better care.
            <br />
            <span>All together.</span>
          </h2>
          <p>
            Your pharmacy, mini-mart, and patient care — connected in one thoughtfully designed
            workspace.
          </p>
          <div className="auth-illustration" aria-hidden="true">
            <div className="auth-illustration-orbit" />
            <div className="auth-center-icon">
              <span className="brand-mark">
                <span />
                <span />
              </span>
            </div>
            <div className="auth-float auth-float-one">
              <Pill size={22} />
              <span>Pharmacy</span>
              <CheckCircle2 size={15} />
            </div>
            <div className="auth-float auth-float-two">
              <Store size={22} />
              <span>Mini-Mart</span>
            </div>
            <div className="auth-float auth-float-three">
              <HeartPulse size={22} />
              <span>Patient care</span>
            </div>
            <div className="auth-art-dot" />
          </div>
          <div className="auth-values">
            <span>
              <Check size={15} />
              Local-first architecture
            </span>
            <span>
              <Check size={15} />
              Individual staff access
            </span>
            <span>
              <Check size={15} />
              Your business, your data
            </span>
          </div>
        </div>
        <div className="auth-story-footer">
          <ShieldCheck size={17} />
          <span>A secure foundation for the work that matters.</span>
        </div>
      </aside>
      <main className="auth-main">
        <div className="auth-top">
          <Link to="/" className="back-link">
            <ArrowLeft size={16} />
            Back to workspace
          </Link>
          <span className="auth-version">PHASE 01</span>
        </div>
        <div className="auth-form-container">
          <div className="auth-form-icon">
            {register ? <UserRound size={25} /> : <LockKeyhole size={25} />}
          </div>
          <span className="eyebrow">
            {register ? 'YOUR WORKSPACE STARTS HERE' : 'WELCOME TO YOUR WORKSPACE'}
          </span>
          <h1>{register ? 'A strong start.' : 'Welcome back.'}</h1>
          <p className="auth-subtitle">
            {register
              ? 'Create the first owner account for your MediMart server.'
              : 'Sign in to keep your business in good health.'}
          </p>
          {registrationUnavailable && (
            <div className="info-box">
              <ShieldCheck size={20} />
              <p>
                {runtime.native
                  ? 'The first owner must be created from the central server’s browser. Then pair this Android device in Settings.'
                  : bootstrap?.required === false
                    ? 'Your owner account is already set up. An authorized administrator can create individual staff accounts.'
                    : 'Owner setup is not enabled. Run npm run setup on the central server, then restart the API.'}
              </p>
            </div>
          )}
          <FormError message={error} />
          <form
            onSubmit={(event) => {
              void submit(event);
            }}
            className="auth-form"
          >
            {register && (
              <label className="field-label">
                Full name
                <div className="input-with-icon">
                  <UserRound size={17} />
                  <input
                    name="fullName"
                    autoComplete="name"
                    placeholder="Your full name"
                    minLength={2}
                    maxLength={120}
                    required
                    disabled={registrationUnavailable}
                  />
                </div>
              </label>
            )}
            <label className="field-label">
              Email address
              <div className="input-with-icon">
                <Mail size={17} />
                <input
                  name="email"
                  type="email"
                  autoComplete="username"
                  placeholder="you@yourbusiness.com"
                  maxLength={254}
                  required
                  disabled={registrationUnavailable}
                />
              </div>
            </label>
            <label className="field-label">
              <span className="label-row">
                Password
                {!register && (
                  <button type="button" className="inline-button" onClick={() => setHelp(true)}>
                    Need help signing in?
                  </button>
                )}
              </span>
              <div className="input-with-icon">
                <LockKeyhole size={17} />
                <input
                  aria-label="Password"
                  name="password"
                  type={showPassword ? 'text' : 'password'}
                  autoComplete={register ? 'new-password' : 'current-password'}
                  placeholder={register ? 'Choose a strong passphrase' : 'Enter your password'}
                  minLength={register ? 12 : 1}
                  maxLength={128}
                  required
                  disabled={registrationUnavailable}
                />
                <button
                  type="button"
                  className="password-toggle"
                  aria-label={showPassword ? 'Hide password' : 'Show password'}
                  onClick={() => setShowPassword((shown) => !shown)}
                >
                  {showPassword ? <EyeOff size={17} /> : <Eye size={17} />}
                </button>
              </div>
              {register && (
                <small>At least 12 characters. A long, unique passphrase works well.</small>
              )}
            </label>
            {register && (
              <label className="field-label">
                Server setup token
                <div className="input-with-icon">
                  <KeyRound size={17} />
                  <input
                    aria-label="Server setup token"
                    name="bootstrapToken"
                    type="password"
                    autoComplete="off"
                    placeholder="One-time token from your server’s .env"
                    minLength={32}
                    maxLength={128}
                    required
                    disabled={registrationUnavailable}
                  />
                </div>
                <small>This closes permanently after the first owner is created.</small>
              </label>
            )}
            <Button
              type="submit"
              busy={busy}
              disabled={registrationUnavailable}
              className="auth-submit"
            >
              {register ? 'Create owner account' : 'Sign in to MediMart'}
              <ArrowRight size={17} />
            </Button>
            <p className="auth-security-note">
              <ShieldCheck size={14} />
              {register
                ? 'Protected with Argon2id password hashing.'
                : 'Secure access. Individual accounts. Peace of mind.'}
            </p>
          </form>
          <div className="auth-divider">
            <span>OR TAKE A LOOK AROUND</span>
          </div>
          <Link className="button button-secondary auth-preview-button" to="/">
            Explore the workspace
            <ArrowUpRight size={17} />
          </Link>
          <div className="auth-switch">
            {register ? (
              <>
                Already have an account? <Link to="/login">Sign in</Link>
              </>
            ) : bootstrap?.required && !runtime.native ? (
              <>
                Setting up for the first time? <Link to="/register">Create owner account</Link>
              </>
            ) : (
              <>
                Need an account?{' '}
                <button className="inline-button" onClick={() => setHelp(true)}>
                  Contact your administrator
                </button>
              </>
            )}
          </div>
          {runtime.native && (
            <Link className="auth-native-settings" to="/settings?tab=connection">
              <Server size={15} />
              Configure server & device pairing
              <ArrowRight size={14} />
            </Link>
          )}
        </div>
        <footer className="auth-main-footer">
          <span>© {new Date().getFullYear()} MediMart</span>
          <span className={connection === 'online' ? 'text-green' : 'muted'}>
            {connection === 'online' ? <Wifi size={13} /> : <WifiOff size={13} />}
            {connection === 'online'
              ? 'Central server connected'
              : connection === 'checking'
                ? 'Checking your connection'
                : 'Central server unavailable'}
          </span>
        </footer>
      </main>
      <Modal open={help} onClose={() => setHelp(false)} title="Help with your account">
        <div className="help-content">
          <h3>Your account belongs to you.</h3>
          <p>
            Ask your owner or administrator to create an individual staff account. There are no
            shared default credentials.
          </p>
          <p>
            If you cannot sign in, check your local server connection and email address. After five
            unsuccessful attempts, wait 15 minutes before trying again.
          </p>
          <div className="info-box">
            <LockKeyhole size={20} />
            <p>
              Self-service password recovery and offline sign-in enrollment are not available in
              Phase 1. Do not send your password or setup token to anyone.
            </p>
          </div>
          <Button onClick={() => setHelp(false)}>Got it</Button>
        </div>
      </Modal>
    </div>
  );
}
