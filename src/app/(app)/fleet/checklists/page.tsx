// Driver MVP (docs/design/driver-mvp.md §1). Static, phone-readable
// step lists - standardized practice rendered in the UI, not stored
// data (same treatment as the pre-trip checklist prompts). Written to
// be worked top-to-bottom at the truck, in order.

import type { Metadata } from "next";
import PageHeader from "@/components/PageHeader";

export const metadata: Metadata = { title: "Checklists — Trucking OS" };

function Steps({ items }: { items: string[] }) {
  return (
    <ol>
      {items.map((item) => (
        <li key={item}>{item}</li>
      ))}
    </ol>
  );
}

export default function ChecklistsPage() {
  return (
    <div>
      <PageHeader title="Checklists" purpose="Coupling, uncoupling, docking, and paperwork — step by step, written to be worked top to bottom at the truck." />

      <section aria-label="Coupling">
        <h2>Coupling (hooking up to a trailer)</h2>
        <Steps
          items={[
            "Inspect the trailer first: tires, landing gear, doors/seal, no obvious damage. Chock the wheels if they aren't already.",
            "Check your fifth wheel: greased (not dry), locking jaws OPEN, plate flat - not tilted up.",
            "Line up straight in front of the trailer and back slowly until the fifth wheel is just under the trailer's front edge.",
            "STOP. Get out and look: trailer height (the fifth wheel should slide under and slightly lift the trailer - too high means a high-hook, kingpin over the jaws), and kingpin lined up with the fifth wheel throat. Adjust trailer height with the landing gear if needed.",
            "Back under slowly until you feel and hear the jaws lock. Set the brakes.",
            "Tug test: release the tractor brakes only (trailer brakes still set) and ease forward gently. You should feel solid resistance and the trailer should try to follow. If it doesn't hold, you are NOT coupled - stop.",
            "Get out with a flashlight and LOOK: jaws closed around the kingpin shank (never on top of it), release handle all the way in, no gap between the fifth wheel plate and the trailer apron.",
            "Connect the air lines - red to red (supply/emergency), blue to blue (service), never crossed - and the electrical cord. Check the gladhand seals aren't cracked.",
            "Supply air to the trailer (push the red trailer-supply knob in), let pressure build, then walk the trailer: listen for air leaks and check the trailer lights with your signals and brakes on.",
            "Raise the landing gear ALL the way up and stow the crank handle. Remove the chocks.",
            "Final walk-around of the whole rig before you move.",
          ]}
        />
      </section>

      <section aria-label="Uncoupling">
        <h2>Uncoupling (dropping a trailer)</h2>
        <Steps
          items={[
            "Park straight on firm, level ground. Set both parking brakes.",
            "Lower the landing gear and take the trailer's weight BEFORE pulling the fifth-wheel release. Never release with the trailer's weight still on the truck and no gear down.",
            "Disconnect the electrical cord and air lines; hang them so the gladhands stay clean and can't drag.",
            "Pull the fifth-wheel release handle.",
            "Pull forward slowly until the fifth wheel clears the trailer apron, stop, and check the landing gear is holding the trailer level and stable.",
            "Drive clear. If the spot requires it, chock the trailer wheels and note the trailer's position.",
          ]}
        />
      </section>

      <section aria-label="Docking and backing">
        <h2>Docking &amp; backing</h2>
        <Steps
          items={[
            "GOAL - Get Out And Look, every time you're unsure. Professional drivers do this; only rookies guess.",
            "Set up straight where you can: pull past the dock, then back in one smooth move instead of jackknifing from an angle.",
            "Small steering inputs. With your hands at the bottom of the wheel, move your hand the direction you want the trailer's back end to go.",
            "Windows down, radio off, both mirrors in use - plus the spotter mirror for the dock side.",
            "Many docks want trailer doors opened and secured BEFORE you back against the dock; some are the opposite. Ask, or watch the driver ahead of you.",
            "Once docked: brakes set, and follow the dock's rule - driver waiting area, keys in, wheels chocked. Don't wander the warehouse floor.",
          ]}
        />
      </section>

      <section aria-label="At the shipper or receiver">
        <h2>At the shipper / receiver - paperwork</h2>
        <Steps
          items={[
            "Check in FIRST, before parking in a door: find the shipping/receiving office or guard shack. Have your name, the company name you're running under, the load/pickup number, and your CDL ready.",
            "Get your door assignment, dock per the steps above, and stay where they tell you to wait.",
            "Write down your times: arrival, door, loading done. Detention (waiting) time is money later - times written down are how it gets paid.",
            "Before you leave, check the BOL (bill of lading): pickup and delivery addresses correct, piece/pallet count matches what was loaded, weight listed, load number matches your dispatch message.",
            "If the trailer is sealed: the seal number on the BOL must match the physical seal on the door, digit for digit. Photograph the seal.",
            "Sign the BOL, print your name, date and time it, and get YOUR copy. Photograph every page immediately and upload it under More → Documents, attached to the load.",
            "If anything on the BOL is wrong, write what's wrong ON the BOL before signing, and check with dispatch before you roll.",
            "At delivery the flow is the same: check in first, get the door, get the BOL signed by the receiver before you leave, photograph it, and note any damage or shortage the receiver writes on it - that note is what protects you.",
          ]}
        />
      </section>
    </div>
  );
}
