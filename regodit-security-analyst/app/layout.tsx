export const metadata = {
  title: 'Regodit AI Security Analyst',
  description: 'Conversational security questionnaire completion',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body style={{ fontFamily: 'system-ui, sans-serif', margin: 0, background: '#0b0f14', color: '#e6edf3' }}>
        {children}
      </body>
    </html>
  );
}
