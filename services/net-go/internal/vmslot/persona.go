package vmslot

import (
	"crypto/rand"
	"encoding/hex"
	"fmt"
	"strings"
)

// GeneratePersona creates an immutable, non-zero cryptographic hardware fingerprint for a VM/container slot.
func GeneratePersona(cpuModel, timezone, dohURL string, cpuCores uint32) (HardwarePersona, error) {
	var machineBytes [16]byte
	for attempt := 0; attempt < 4; attempt++ {
		if _, err := rand.Read(machineBytes[:]); err != nil {
			return HardwarePersona{}, fmt.Errorf("vmslot: generate guest_machine_id: %w", err)
		}
		allZero := true
		for _, b := range machineBytes {
			if b != 0 {
				allZero = false
				break
			}
		}
		if !allZero {
			break
		}
		machineBytes[0] = 0xa5
	}

	var macBytes [6]byte
	if _, err := rand.Read(macBytes[:]); err != nil {
		return HardwarePersona{}, fmt.Errorf("vmslot: generate mac_address: %w", err)
	}
	macBytes[0] = (macBytes[0] | 0x02) & 0xfe // locally administered unicast MAC

	var uuidBytes [16]byte
	if _, err := rand.Read(uuidBytes[:]); err != nil {
		return HardwarePersona{}, fmt.Errorf("vmslot: generate smbios_uuid: %w", err)
	}
	uuidBytes[6] = (uuidBytes[6] & 0x0f) | 0x40
	uuidBytes[8] = (uuidBytes[8] & 0x3f) | 0x80

	var serialBytes [4]byte
	if _, err := rand.Read(serialBytes[:]); err != nil {
		return HardwarePersona{}, fmt.Errorf("vmslot: generate smbios_serial: %w", err)
	}

	if strings.TrimSpace(cpuModel) == "" {
		cpuModel = "AMD EPYC 9654 96-Core Processor"
	}
	if cpuCores == 0 {
		cpuCores = 4
	}
	if strings.TrimSpace(timezone) == "" {
		timezone = "UTC"
	}
	if strings.TrimSpace(dohURL) == "" {
		dohURL = "https://1.1.1.1/dns-query"
	}

	return HardwarePersona{
		GuestMachineID: hex.EncodeToString(machineBytes[:]),
		MACAddress: fmt.Sprintf("%02x:%02x:%02x:%02x:%02x:%02x",
			macBytes[0], macBytes[1], macBytes[2], macBytes[3], macBytes[4], macBytes[5]),
		SMBIOSUUID: fmt.Sprintf("%08x-%04x-%04x-%04x-%012x",
			uuidBytes[0:4], uuidBytes[4:6], uuidBytes[6:8], uuidBytes[8:10], uuidBytes[10:16]),
		SMBIOSSerial: "SG-VM-" + strings.ToUpper(hex.EncodeToString(serialBytes[:])),
		CPUModel:     strings.TrimSpace(cpuModel),
		CPUCores:     cpuCores,
		Timezone:     strings.TrimSpace(timezone),
		DoHURL:       strings.TrimSpace(dohURL),
	}, nil
}
