import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import App from "./App";
import Login from "./pages/Login";
import { AppProvider } from "./store/AppContext";
import { AuthProvider, useAuth } from "./store/AuthContext";
import { FeaturesProvider } from "./store/FeaturesContext";
import "./index.css";

/** Decides between the login screen and the authenticated app shell. */
function Root() {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-slate-50 dark:bg-slate-950">
        <div className="h-8 w-8 animate-spin rounded-full border-2 border-slate-300 border-t-brand-600" />
      </div>
    );
  }

  if (!user) return <Login />;

  // Remount the data layer + app whenever the signed-in user changes so a
  // fresh, correctly-scoped dataset is loaded for the new session.
  return (
    <AppProvider key={user.id}>
      <FeaturesProvider>
        <App />
      </FeaturesProvider>
    </AppProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserRouter>
      <AuthProvider>
        <Root />
      </AuthProvider>
    </BrowserRouter>
  </React.StrictMode>,
);
