// config.js
// Centralized configuration for the Sporebot landing page and integrations

const config = {
  site: {
    title: "Welcome to Mushroom Planet",
    headerTitle: "Mushroom Planet",
    description: "The Official Home of the SHROOM & SPORE Token, Mooshie NFTs & Sporebot Farming! ",
    url: "https://mushroomplanet.earth/" // Update this to your actual domain
  },

  discord: {
    inviteCode: "RgUh9kHx86",
    inviteURL: "https://discord.com/invite/ECauU2KSSt",
    guildID: "1190059108368400535"
  },

  theme: {
    colors: {
      primary: "#cece1a",       // Cream text or background
      secondary: "#003bfe",     // Yellow highlights
      accent: "#4652fd",        // Red accent
      dark: "#1a1a1a",          // Dark section background
      light: "#e8e8d0",         // Light section background (cream-like)

      sections: {
        altLightBg: "#ffe1fc",   // Alt section: cream background
        altLightText: "#1a1a1a", // ...with dark text
        altDarkBg: "#1a1a1a",    // Alt section: dark background
        altDarkText: "#ffffe1"  // ...with light text
      },

      embed: {
        background: "#fd464f",
        border: "#fee599",
        text: "#ffffe1",
        link: "#ffffe1"
      }
    },
    fonts: {
      heading: "'Inter', sans-serif",
      body: "'Inter', sans-serif"
    }
  },

  metadata: {
    googleFonts: ["Inter:wght@400;600;800"],
    socialCard: {
      title: "Sporebot | Mushroom Farming Bot",
      description: "Join our Discord to start your mushroom farm journey with Sporebot!",
      image: "/images/social-card.png"  // Update if you change the OG image
    }
  },

  analytics: {
    googleAnalyticsID: "UA-XXXXXXXXX-X" // Replace with your real GA ID
  },

  menu: {
    html: `
      <div class="main-menu desktop-only">
        <a href="/profile">Sporebot</a>
        <a href="/earn">Earn</a>
        <a href="/convert">Convert</a>
        <a href="/vote">Governance</a>
        <a href="/treasury">Treasury</a>
        <a href="/guides">Guides</a>
      </div>

      <div class="mobile-menu mobile-only">
        <a href="/profile">Sporebot</a>
        <a href="/earn">Earn</a>
        <a href="/convert">Convert</a>
        <a href="/vote">Vote</a>
        <a href="/treasury">Treasury</a>
        <a href="/guides">Guides</a>
      </div>
    `
  }
};

(function() {
  var lastY = 0, ticking = false;
  window.addEventListener('scroll', function() {
    if (!ticking) {
      requestAnimationFrame(function() {
        var y = window.scrollY;
        var header = document.querySelector('header');
        var menu = document.getElementById('global-menu');
        if (y > 60) {
          if (header) header.classList.add('hide-header');
          if (menu) menu.classList.add('hide-header');
        } else {
          if (header) header.classList.remove('hide-header');
          if (menu) menu.classList.remove('hide-header');
        }
        lastY = y;
        ticking = false;
      });
      ticking = true;
    }
  });

  // Scroll to top button
  var btn = document.createElement('button');
  btn.id = 'scroll-top-btn';
  btn.setAttribute('aria-label', 'Scroll to top');
  btn.innerHTML = '<svg viewBox="0 0 24 24"><polyline points="18 15 12 9 6 15"></polyline></svg>';
  btn.addEventListener('click', function() { window.scrollTo({ top: 0, behavior: 'smooth' }); });
  document.addEventListener('DOMContentLoaded', function() { document.body.appendChild(btn); });

  window.addEventListener('scroll', function() {
    if (window.scrollY > 300) {
      btn.classList.add('visible');
    } else {
      btn.classList.remove('visible');
    }
  });
})();

export default config;
