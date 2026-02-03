import '../tailwind.css'
import '../styles.css'
import { Toaster } from 'react-hot-toast'

export default function App({ Component, pageProps }) {
	return (
		<>
			<Toaster
				position="top-right"
				toastOptions={{
					style: { background: '#0f172a', color: '#e2e8f0', border: '1px solid #1e293b' },
					success: { iconTheme: { primary: '#22c55e', secondary: '#0f172a' } },
					error: { iconTheme: { primary: '#ef4444', secondary: '#0f172a' } },
				}}
			/>
			<Component {...pageProps} />
		</>
	)
}
